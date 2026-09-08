import { EventEmitter } from 'events'
import type { ActorRegistry } from './actors.ts'
import { IdempotencyCache } from './idempotency.ts'
import type { Journal } from './journal.ts'
import type { LockManager } from './locks.ts'
import { MetricsRegistry } from './metrics.ts'
import { OverlayManager, type ShadowOverlay } from './overlay.ts'
import { ActorRateLimiter, PriorityCommandQueue } from './queue.ts'
import { fileResource, parseResource } from './resources.ts'
import {
  validatePayload,
  type CommandDefinition
} from './schema.ts'
import {
  CommandError,
  type Command,
  type CommandHandler,
  type CommandResult,
  type DryRunResult,
  type JournalEntry,
  type JournalPhase,
  type ResourceId,
  type ResourceScheme,
  type SpeculativeResult,
  type TransactionOptions,
  type TransactionResult,
  type VersionSource
} from './types.ts'
import { VersionRegistry } from './versioned.ts'

export interface CommandFlowOptions {
  actors: ActorRegistry
  locks: LockManager
  journal: Journal
  now?: () => number
  /** TTL of the implicit lock the bus takes around a single apply. */
  implicitLockTtlMs?: number
  maxQueueLength?: number
  rateLimitPerSec?: number
  rateLimitBurst?: number
}

/**
 * The unified write path of OrcSpace.
 *
 * Implements:
 * - Schema validation as single source of truth + command catalog.
 * - Idempotency-Key caching and replay prevention.
 * - Priority queue with user preemption and actor rate-limiting backpressure.
 * - In-flight command cancellation (AbortSignal).
 * - Multi-command atomic transactions (flow.transact).
 * - Shadow overlays for dry-run and speculative planning.
 */
/**
 * Central command dispatcher: the single, observable write path for OrcSpace.
 *
 */
export class CommandFlow extends EventEmitter {
  private readonly handlers = new Map<string, CommandHandler<never, unknown>>()
  private readonly definitions = new Map<string, CommandDefinition>()
  private readonly versions = new Map<ResourceScheme, VersionSource>()
  private readonly actors: ActorRegistry
  private readonly locks: LockManager
  private readonly journal: Journal
  private readonly implicitLockTtl: number
  readonly overlays: OverlayManager
  readonly idempotency: IdempotencyCache
  readonly rateLimiter: ActorRateLimiter
  readonly pQueue: PriorityCommandQueue
  private readonly cancellations = new Map<string, AbortController>()
  private readonly now: () => number
  /** Counters/gauges/latencies of the write path — surfaced via {@link stats}. */
  readonly metrics = new MetricsRegistry()
  private cmdCounter = 0

  constructor(options: CommandFlowOptions) {
    super()
    this.actors = options.actors
    this.locks = options.locks
    this.journal = options.journal
    this.now = options.now ?? Date.now
    this.implicitLockTtl = options.implicitLockTtlMs ?? 15_000
    this.overlays = new OverlayManager(this.now)
    this.idempotency = new IdempotencyCache({ now: options.now })
    this.rateLimiter = new ActorRateLimiter({
      capacity: options.rateLimitBurst ?? 40,
      refillPerSec: options.rateLimitPerSec ?? 25,
      now: options.now
    })
    this.pQueue = new PriorityCommandQueue({ maxQueueLength: options.maxQueueLength ?? 500 })
  }

  // ---- Schema and command registration ------------------------------------

  register<P, R>(type: string, handler: CommandHandler<P, R>): void {
    if (!type.trim()) throw new Error('command type must not be empty')
    if (this.handlers.has(type)) throw new Error(`command ${type} is already registered`)
    this.handlers.set(type, handler as CommandHandler<never, unknown>)
  }

  registerDefinition<P, R>(def: CommandDefinition<P, R>): void {
    if (!def.type.trim()) throw new Error('command type must not be empty')
    if (this.definitions.has(def.type) || this.handlers.has(def.type)) {
      throw new Error(`command ${def.type} is already registered`)
    }
    // Validate before mutating either registry. This keeps the catalog and
    // handler map consistent when registration is attempted twice.
    this.definitions.set(def.type, def as CommandDefinition)
    if (def.handler) {
      try {
        this.register(def.type, {
          requiresLock: def.requiresLock,
          ignoreVersion: def.ignoreVersion,
          transient: def.transient ?? def.handler.transient,
          bypassQueue: def.bypassQueue ?? def.handler.bypassQueue,
          description: def.description,
          apply: def.handler.apply
        })
      } catch (error) {
        this.definitions.delete(def.type)
        throw error
      }
    }
  }

  getDefinition(type: string): CommandDefinition | undefined {
    return this.definitions.get(type)
  }

  catalog(): CommandDefinition[] {
    return Array.from(this.definitions.values()).sort((a, b) => a.type.localeCompare(b.type))
  }

  registerVersions(scheme: ResourceScheme, source: VersionSource): void {
    this.versions.set(scheme, source)
  }

  knows(type: string): boolean {
    return this.handlers.has(type)
  }

  types(): string[] {
    return Array.from(this.handlers.keys()).sort()
  }

  versionOf(target: ResourceId, overlayId?: string): number {
    const parsed = parseResource(target)
    if (!parsed) return 0
    const source = this.versions.get(parsed.scheme)
    if (!source) return 0
    if (source instanceof VersionRegistry) {
      return source.versionOf(target, overlayId) ?? 0
    }
    return source.versionOf(target) ?? 0
  }

  /**
   * The queue lanes a command contends for: one per normalized resource id.
   * Commands on disjoint resources never share a lane, so a paced
   * `terminal.write` in one shell no longer parks a note edit behind it —
   * same-target commands still run strictly one at a time.
   */
  private lanesOf(command: Command): string[] {
    const parsed = parseResource(command.target)
    if (!parsed) return [command.target]
    return [parsed.scheme === 'file' ? fileResource(parsed.id) : command.target]
  }

  private lanesOfCommands(commands: Command[]): string[] {
    const lanes = new Set<string>()
    for (const cmd of commands) for (const lane of this.lanesOf(cmd)) lanes.add(lane)
    return [...lanes].sort()
  }

  /** Live write-path metrics plus queue gauges, for sys-monitor-style surfaces. */
  stats(): ReturnType<MetricsRegistry['snapshot']> & { queueDepth: number; busyLanes: number } {
    return {
      ...this.metrics.snapshot(),
      queueDepth: this.pQueue.totalLength,
      busyLanes: this.pQueue.busyLaneCount
    }
  }

  // ---- Shared execution pipeline -------------------------------------------
  //
  // `apply` and `applyTransaction` run the same gates in the same order:
  // prepare → lock gate → version gate → intent → handler → commit/abort.
  // These helpers are that pipeline; sharing them is what stops single-command
  // and transactional semantics from drifting apart again (they already had —
  // transient commands skipped locks in one path but not the other).

  /** Handler lookup, payload-schema validation, target normalization, actor check. */
  private prepare(raw: Command): { handler: CommandHandler<never, unknown>; command: Command } {
    const handler = this.handlers.get(raw.type)
    if (!handler) throw new CommandError('unknown_command', `no handler for ${raw.type}`)
    const def = this.definitions.get(raw.type)
    if (def) {
      const schemaErr = validatePayload(def.payloadSchema, raw.payload)
      if (schemaErr) throw new CommandError('invalid', `invalid payload for ${raw.type}: ${schemaErr}`)
    }
    const parsed = parseResource(raw.target)
    if (!parsed) {
      throw new CommandError('invalid', `"${raw.target}" is not a resource id (expected scheme:id)`)
    }
    const target = parsed.scheme === 'file' ? fileResource(parsed.id) : raw.target
    this.actors.require(raw.actorId)
    return { handler, command: { ...raw, target } }
  }

  /** Refuses to touch a resource another actor holds. */
  private assertUnlockedFor(cmd: Command): void {
    if (!this.locks.isLockedByOther(cmd.target, cmd.actorId)) return
    const lock = this.locks.holder(cmd.target)
    throw new CommandError('locked', `${cmd.target} is locked by ${lock?.actorId}`, { lock })
  }

  /** Takes the implicit gate lock; caller releases the returned id in `finally`. */
  private takeImplicitLockFor(cmd: Command, ttlMs: number | undefined, reason: string): ResourceId {
    this.locks.acquire({
      resource: cmd.target,
      actorId: cmd.actorId,
      ttlMs: ttlMs ?? this.implicitLockTtl,
      reason,
      implicit: true
    })
    return cmd.target
  }

  private exitLockGate(lock: ResourceId | null, actorId: string): void {
    if (!lock) return
    try {
      if (this.locks.holder(lock)?.implicit === true) this.locks.release(lock, actorId)
    } catch {
      /* the TTL sweeper or an operator may have dropped it already */
    }
  }

  /** Optimistic-concurrency gate against a possibly simulated current version. */
  private assertVersionGate(handler: CommandHandler<never, unknown>, cmd: Command, expectedCurrent: number): void {
    if (handler.ignoreVersion === true || typeof cmd.baseVersion !== 'number' || cmd.baseVersion === expectedCurrent) {
      return
    }
    throw new CommandError(
      'conflict',
      `${cmd.target} moved on: expected version ${cmd.baseVersion}, found ${expectedCurrent}`,
      { target: cmd.target, expected: cmd.baseVersion, actual: expectedCurrent }
    )
  }

  /** Appends to the real journal, or mirrors the entry into a shadow overlay's log. */
  private journalOrOverlay(
    entry: {
      phase: JournalPhase
      actorId: string
      type: string
      target: ResourceId
      payload?: unknown
      version?: number
      error?: string
    },
    overlayId: string | undefined,
    overlaySeq = 0
  ): JournalEntry | undefined {
    if (overlayId) {
      this.overlays.get(overlayId)?.recordLog({ seq: overlaySeq, at: this.now(), ...entry })
      return undefined
    }
    return this.journal.append(entry)
  }

  /** Prefers the store-reported version, then a version the handler created, then entry-point version. */
  private resolveResultVersion(target: ResourceId, overlayId: string | undefined, data: unknown, fallback: number): number {
    const created = (data as { version?: unknown } | null)?.version
    return this.versionOf(target, overlayId) || (typeof created === 'number' ? created : 0) || fallback
  }

  // ---- In-flight cancellation ---------------------------------------------

  cancel(commandId: string, reason = 'cancelled'): boolean {
    const ctrl = this.cancellations.get(commandId)
    if (!ctrl) return false
    ctrl.abort(reason)
    this.cancellations.delete(commandId)
    this.metrics.inc('flow.cancelled')
    this.emit('cancelled', { commandId, reason })
    return true
  }

  // ---- Shadow overlay management ------------------------------------------

  createOverlay(overlayId: string): ShadowOverlay {
    const overlay = this.overlays.create(overlayId)
    for (const source of this.versions.values()) {
      if (source instanceof VersionRegistry) {
        source.createOverlay(overlayId)
      }
    }
    return overlay
  }

  getOverlay(overlayId: string): ShadowOverlay | undefined {
    return this.overlays.get(overlayId)
  }

  hasOverlay(overlayId: string): boolean {
    return this.overlays.has(overlayId)
  }

  discardOverlay(overlayId: string): boolean {
    for (const source of this.versions.values()) {
      if (source instanceof VersionRegistry) {
        source.discard(overlayId)
      }
    }
    return this.overlays.discard(overlayId)
  }

  async commitOverlay(overlayId: string, actorId = 'system'): Promise<CommandResult<{ overlayId: string }>> {
    const overlay = this.overlays.get(overlayId)
    if (!overlay) {
      return { ok: false, code: 'not_found', message: `overlay ${overlayId} not found` }
    }
    for (const source of this.versions.values()) {
      if (source instanceof VersionRegistry) {
        source.commit(overlayId)
      }
    }
    const diff = overlay.diff()
    this.overlays.discard(overlayId)
    const entry = this.journal.append({
      phase: 'commit',
      actorId,
      type: 'overlay.commit',
      target: 'system:overlay',
      payload: { overlayId, diff }
    })
    return { ok: true, seq: entry.seq, version: entry.seq, data: { overlayId } }
  }

  async dryRun<T = unknown>(commands: Command | Command[]): Promise<DryRunResult<T>> {
    const overlayId = `dryrun-${this.now()}-${Math.random().toString(36).slice(2, 7)}`
    const overlay = this.createOverlay(overlayId)
    try {
      const list = Array.isArray(commands) ? commands : [commands]
      const res =
        list.length === 1
          ? await this.submit<T>(list[0], { overlayId })
          : await this.transact<T>(list, { overlayId })

      return {
        ok: res.ok,
        code: res.ok ? undefined : res.code,
        message: res.ok ? undefined : res.message,
        details: res.ok ? undefined : res.details,
        data: res.ok ? (res.data as T) : undefined,
        diff: overlay.diff(),
        logs: overlay.getLogs()
      }
    } finally {
      this.discardOverlay(overlayId)
    }
  }

  async speculate<T = unknown>(
    plans: Record<string, Command[]>
  ): Promise<Record<string, SpeculativeResult<T>>> {
    const out: Record<string, SpeculativeResult<T>> = {}
      for (const [planId, commands] of Object.entries(plans)) {
        const overlayId = `spec-${planId}-${this.now()}`
      const overlay = this.createOverlay(overlayId)
      try {
        const res = await this.transact<T>(commands, { overlayId })
        out[planId] = {
          planId,
          ok: res.ok,
          code: res.ok ? undefined : res.code,
          message: res.ok ? undefined : res.message,
          data: res.ok ? (res.data as T) : undefined,
          diff: overlay.diff()
        }
      } finally {
        this.discardOverlay(overlayId)
      }
    }
    return out
  }

  // ---- Single command submit ----------------------------------------------

  submit<T = unknown>(command: Command, options?: { overlayId?: string }): Promise<CommandResult<T>> {
    // The caller's object is never mutated: the bus owns its copy from here on.
    // A caller re-submitting the same literal must not find an id, or any other
    // bus-assigned field, written onto it as a side effect.
    const cmd: Command = { ...command }
    this.cmdCounter += 1
    const commandId = cmd.id || `cmd-${this.now()}-${this.cmdCounter}`
    cmd.id = commandId
    const submittedAt = this.now()
    this.metrics.inc('flow.submitted')

    // 1. Idempotency Check
    if (cmd.idempotencyKey) {
      const cached = this.idempotency.get<T>(cmd.idempotencyKey)
      if (cached) {
        if (cached.result) return Promise.resolve(cached.result)
        if (cached.inFlight) return cached.inFlight
      }
    }

    // 2. Rate Limiting Check
    // Privilege is a property of who you are, not of what you ask for: letting
    // a command's own `priority: 'high'` buy a rate-limit exemption would let
    // any external agent mark its loop high and bypass runaway protection.
    const actor = this.actors.get(cmd.actorId)
    const isPrivileged = !actor || actor.type === 'user' || actor.type === 'system'
    if (!isPrivileged && !this.rateLimiter.tryConsume(cmd.actorId)) {
      this.metrics.inc('flow.rate_limited')
      return Promise.resolve({
        ok: false,
        code: 'rate_limited',
        message: '429 Rate limit exceeded for actor',
        commandId
      })
    }

    // 2b. Hot-path fast lane. `terminal.input` (one command per keypress) and
    // `terminal.resize` are marked bypassQueue: they mutate a pty, not shared
    // state, so serializing them behind the rest of the app's writes bought
    // nothing and cost every keystroke the latency of whatever the lane was
    // busy with. They still run through apply() — validation, actor check and
    // the lock gate all still apply.
    const fastHandler = this.handlers.get(cmd.type)
    if (fastHandler?.bypassQueue === true && !options?.overlayId) {
      const fastCtrl = new AbortController()
      this.cancellations.set(commandId, fastCtrl)
      const fastStartedAt = submittedAt
      const fast = this.apply<T>(cmd, () => {}, undefined, fastCtrl.signal).finally(() => {
        this.metrics.observe('flow.apply_ms', Math.max(0, this.now() - fastStartedAt))
        this.cancellations.delete(commandId)
      })
      if (cmd.idempotencyKey) this.idempotency.track(cmd.idempotencyKey, fast)
      return fast
    }

    // 3. Setup In-flight Cancellation Controller
    const abortCtrl = new AbortController()
    this.cancellations.set(commandId, abortCtrl)

    // 4. Priority Enqueue
    // enqueue() throws synchronously when the queue is full; submit() itself
    // is not async, so a `void submit(...).catch(...)` caller would never see
    // that rejection. Convert the throw into the same {ok:false} result the
    // rate-limiter path already returns, keeping "submit never throws".
    let taskPromise: Promise<CommandResult<T>>
    try {
      taskPromise = this.pQueue.enqueue({
        id: commandId,
        priority: cmd.priority ?? (actor?.type === 'user' ? 'high' : 'normal'),
        actorId: cmd.actorId,
        lanes: this.lanesOf(cmd),
        run: async (unblock) => {
          this.metrics.observe('flow.queue_wait_ms', Math.max(0, this.now() - submittedAt))
          const startedAt = this.now()
          try {
            return await this.apply<T>(cmd, unblock, options?.overlayId, abortCtrl.signal)
          } finally {
            this.metrics.observe('flow.apply_ms', Math.max(0, this.now() - startedAt))
          }
        }
      }).finally(() => {
        this.cancellations.delete(commandId)
      })
    } catch (err) {
      this.metrics.inc('flow.backpressure')
      this.cancellations.delete(commandId)
      taskPromise = Promise.resolve({
        ok: false,
        code: 'backpressure',
        message: err instanceof Error ? err.message : String(err),
        commandId
      })
    }

    if (cmd.idempotencyKey) {
      this.idempotency.track(cmd.idempotencyKey, taskPromise)
    }

    return taskPromise
  }

  /**
   * Runs a command from inside another handler. With per-resource lanes the
   * old ambient depth counter is unreliable — a concurrent top-level command
   * on another lane would make an external submit look "nested" — so nesting
   * is now declared, not detected: pass `{ nested: true }` to skip the queue,
   * or nothing to behave exactly like {@link submit}.
   */
  async submitNested<T = unknown>(
    command: Command,
    options?: { overlayId?: string; signal?: AbortSignal; nested?: boolean }
  ): Promise<CommandResult<T>> {
    if (options?.nested === true) {
      return this.apply<T>(command, () => {}, options.overlayId, options.signal)
    }
    return this.submit<T>(command, options)
  }

  // ---- Transactions (Atomic multi-command flow.transact) -------------------

  transact<T = unknown[]>(
    commands: Command[],
    options?: TransactionOptions
  ): Promise<TransactionResult<T>> {
    if (commands.length === 0) {
      return Promise.resolve({
        ok: true,
        seq: this.journal.lastSeq,
        version: this.journal.lastSeq,
        data: [] as unknown as T,
        results: []
      })
    }

    // Idempotency Check
    if (options?.idempotencyKey) {
      const cached = this.idempotency.get<T, TransactionResult<T>>(options.idempotencyKey)
      if (cached) {
        if (cached.result) return Promise.resolve(cached.result)
        if (cached.inFlight) return cached.inFlight
      }
    }

    const primaryActorId = options?.actorId ?? commands[0].actorId
    this.cmdCounter += 1
    const txId = `tx-${Date.now()}-${this.cmdCounter}`
    const primaryActor = this.actors.get(primaryActorId)
    const isPrivileged = !primaryActor || primaryActor.type === 'user' || primaryActor.type === 'system'
    if (!isPrivileged && !this.rateLimiter.tryConsume(primaryActorId)) {
      return Promise.resolve({
        ok: false,
        code: 'rate_limited',
        message: '429 Rate limit exceeded for actor',
        commandId: txId
      })
    }

    const abortCtrl = new AbortController()
    this.cancellations.set(txId, abortCtrl)

    const taskPromise = (() => {
      try {
        return this.pQueue.enqueue<TransactionResult<T>>({
          id: txId,
          priority: options?.priority ?? (primaryActor?.type === 'user' ? 'high' : 'normal'),
          actorId: primaryActorId,
          // A transaction contends on every target it touches: claiming all of
          // its lanes up front (all-or-nothing, never holding some while waiting
          // for others) serializes it against any overlapping single command or
          // transaction without any lock-ordering deadlock being possible.
          lanes: this.lanesOfCommands(commands),
          run: () => this.applyTransaction<T>(commands, options, abortCtrl.signal, txId)
        }).finally(() => {
          this.cancellations.delete(txId)
        })
      } catch (err) {
        this.cancellations.delete(txId)
        return Promise.resolve({
          ok: false,
          code: 'backpressure',
          message: err instanceof Error ? err.message : String(err),
          results: [],
          commandId: txId
        } as TransactionResult<T>)
      }
    })()

    if (options?.idempotencyKey) {
      this.idempotency.track(options.idempotencyKey, taskPromise)
    }

    return taskPromise
  }

  private async applyTransaction<T>(
    commands: Command[],
    options?: TransactionOptions,
    signal?: AbortSignal,
    txId?: string
  ): Promise<TransactionResult<T>> {
    const overlayId = options?.overlayId
    const implicitLocks: ResourceId[] = []
    let intentWritten = false
    const primaryActorId = options?.actorId ?? commands[0].actorId
    const detailedResults: CommandResult[] = []
    const dataResults: unknown[] = []

    try {
      if (signal?.aborted) throw new CommandError('cancelled', 'transaction cancelled before execution')

      // 1. Validation & Actor verification — through the shared pipeline, so a
      // transactional command can never accept what a solo command would refuse.
      const primaryActor = this.actors.require(primaryActorId)
      this.actors.touch(primaryActor.id)

      const validated = commands.map((rawCmd) => this.prepare(rawCmd))
      const validatedCommands: Command[] = validated.map((v) => v.command)

      // 2. Atomic Lock Gate: check every target first, then take — all-or-
      // nothing, so a foreign lock late in the plan cannot leave half held.
      if (!overlayId) {
        for (const v of validated) {
          if (v.handler.requiresLock !== false) this.assertUnlockedFor(v.command)
        }
        for (const v of validated) {
          const cmd = v.command
          if (v.handler.requiresLock === false) continue
          if (!this.locks.isHeldBy(cmd.target, cmd.actorId) && !implicitLocks.includes(cmd.target)) {
            implicitLocks.push(this.takeImplicitLockFor(cmd, options?.implicitLockTtlMs, `transact:${cmd.type}`))
          }
        }
      }

      // 3. Atomic Version Gate — simulated bumps let one target repeat in-plan.
      const simulatedVersions = new Map<ResourceId, number>()
      for (const v of validated) {
        const cmd = v.command
        const currentVersion = simulatedVersions.has(cmd.target)
          ? simulatedVersions.get(cmd.target)!
          : this.versionOf(cmd.target, overlayId)
        this.assertVersionGate(v.handler, cmd, currentVersion)
        simulatedVersions.set(cmd.target, currentVersion + 1)
      }

      // 4. Single Intent Phase in Journal
      const intentEntry = {
        phase: 'intent' as const,
        actorId: primaryActorId,
        type: 'flow.transact',
        target: 'system:transaction',
        payload: {
          commands: validatedCommands.map((c) => ({
            actorId: c.actorId,
            type: c.type,
            target: c.target,
            baseVersion: c.baseVersion,
            payload: c.payload
          }))
        }
      }
      if (overlayId) {
        const overlay = this.overlays.get(overlayId)
        overlay?.recordLog({ seq: 0, at: this.now(), ...intentEntry })
      } else {
        // A transaction always journals: it is the atomic unit recovery
        // replays, whatever the individual commands inside it are marked.
        this.journal.append(intentEntry)
      }
      intentWritten = true

      // 5. Apply each command sequentially
      for (const v of validated) {
        if (signal?.aborted) throw new CommandError('cancelled', 'transaction aborted mid-execution')

        const { handler, command: cmd } = v
        const actor = this.actors.require(cmd.actorId)
        const currentVersion = this.versionOf(cmd.target, overlayId)
        const apply = handler.apply as (ctx: {
          command: Command
          actor: typeof actor
          currentVersion: number
          overlayId?: string
          signal?: AbortSignal
          unblock: () => void
        }) => unknown

        const data = await apply({ command: cmd, actor, currentVersion, overlayId, signal, unblock: () => {} })
        const version = this.resolveResultVersion(cmd.target, overlayId, data, currentVersion)

        const cmdRes: CommandResult = { ok: true, seq: this.journal.lastSeq + 1, version, data }
        detailedResults.push(cmdRes)
        dataResults.push(data)

        if (overlayId) {
          const overlay = this.overlays.get(overlayId)
          overlay?.set(cmd.target, data, version)
        }
      }

      // 6. Single Commit Phase in Journal
      let commitSeq = this.journal.lastSeq + 1
      const commitEntry = {
        phase: 'commit' as const,
        actorId: primaryActorId,
        type: 'flow.transact',
        target: 'system:transaction',
        payload: {
          commands: validatedCommands.map((c, i) => ({
            type: c.type,
            target: c.target,
            version: detailedResults[i]?.ok ? detailedResults[i].version : undefined
          }))
        },
        version: commitSeq
      }

      if (overlayId) {
        const overlay = this.overlays.get(overlayId)
        overlay?.recordLog({ seq: commitSeq, at: this.now(), ...commitEntry })
      } else {
        const entry = this.journal.append(commitEntry)
        commitSeq = entry.seq
      }

      const txResult: TransactionResult<T> = {
        ok: true,
        seq: commitSeq,
        version: commitSeq,
        data: dataResults as unknown as T,
        results: detailedResults,
        commandId: txId
      }

      this.metrics.inc('flow.transactions')
      this.emit('transaction_applied', { commands: validatedCommands, result: txResult })
      return txResult
    } catch (err) {
      const error = err instanceof CommandError ? err : new CommandError('failed', String(err))
      if (intentWritten) {
        const abortEntry = {
          phase: 'abort' as const,
          actorId: primaryActorId,
          type: 'flow.transact',
          target: 'system:transaction',
          error: error.message
        }
        if (overlayId) {
          const overlay = this.overlays.get(overlayId)
          overlay?.recordLog({ seq: 0, at: this.now(), ...abortEntry })
        } else {
          this.journal.append(abortEntry)
        }
      }
      if (!(err instanceof CommandError)) console.error('flow.transact failed', err)
      this.metrics.inc('flow.transactions_rejected')
      this.metrics.inc(`flow.transactions_rejected.${error.code}`)
      const txResult: TransactionResult<T> = {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details,
        results: detailedResults,
        commandId: txId
      }
      this.emit('transaction_rejected', { commands, result: txResult })
      return txResult
    } finally {
      for (const target of implicitLocks) {
        const holder = this.locks.holder(target)
        if (holder?.implicit === true) this.exitLockGate(target, holder.actorId)
      }
    }
  }

  // ---- Internal single apply -----------------------------------------------

  private async apply<T>(
    command: Command,
    unblock: () => void = () => {},
    overlayId?: string,
    signal?: AbortSignal
  ): Promise<CommandResult<T>> {
    let implicitLock: ResourceId | null = null
    let intentWritten = false
    let cmd = command
    try {
      if (signal?.aborted) throw new CommandError('cancelled', 'command cancelled before execution')

      // prepare → lock gate → version gate — the same pipeline a transaction
      // runs, so solo and batched writes can never drift apart.
      const prepared = this.prepare(cmd)
      const { handler } = prepared
      cmd = prepared.command

      const actor = this.actors.require(cmd.actorId)
      this.actors.touch(actor.id)

      // ---- lock gate ----------------------------------------------------
      if (!overlayId && handler.requiresLock !== false) {
        this.assertUnlockedFor(cmd)
        // A transient command is gated by the lock but never takes one: its
        // apply is synchronous, so there is no window for another actor to
        // slip in, and acquiring + releasing per keypress was pure overhead.
        if (handler.transient !== true && !this.locks.isHeldBy(cmd.target, actor.id)) {
          implicitLock = this.takeImplicitLockFor(cmd, undefined, cmd.type)
        }
      }

      // ---- version gate --------------------------------------------------
      const currentVersion = this.versionOf(cmd.target, overlayId)
      this.assertVersionGate(handler, cmd, currentVersion)

      // ---- intent ----------------------------------------------------------
      if (overlayId) {
        this.journalOrOverlay(
          { phase: 'intent', actorId: actor.id, type: cmd.type, target: cmd.target, payload: cmd.payload },
          overlayId
        )
        intentWritten = true
      } else if (handler.transient !== true) {
        this.journal.append({ phase: 'intent', actorId: actor.id, type: cmd.type, target: cmd.target, payload: cmd.payload })
        intentWritten = true
      }

      // ---- apply ----------------------------------------------------------
      const apply = handler.apply as (ctx: {
        command: Command
        actor: typeof actor
        currentVersion: number
        overlayId?: string
        signal?: AbortSignal
        unblock: () => void
      }) => unknown

      const data = (await apply({ command: cmd, actor, currentVersion, overlayId, signal, unblock })) as T
      const version = this.resolveResultVersion(cmd.target, overlayId, data, currentVersion)

      let commitSeq = this.journal.lastSeq + 1
      const commitEntry = {
        phase: 'commit' as const,
        actorId: actor.id,
        type: cmd.type,
        target: cmd.target,
        payload: cmd.payload,
        version
      }

      if (overlayId) {
        const overlay = this.overlays.get(overlayId)
        overlay?.set(cmd.target, data, version)
        overlay?.recordLog({ seq: commitSeq, at: this.now(), ...commitEntry })
      } else if (handler.transient === true) {
        // Nothing was journaled for this command, so it did not advance the
        // sequence; report where the log actually stands.
        commitSeq = this.journal.lastSeq
      } else {
        const entry = this.journal.append(commitEntry)
        commitSeq = entry.seq
      }

      const result: CommandResult<T> = { ok: true, seq: commitSeq, version, data, commandId: cmd.id }
      this.metrics.inc('flow.applied')
      this.emit('applied', { command: cmd, result, actor })
      return result
    } catch (err) {
      const error = err instanceof CommandError ? err : new CommandError('failed', String(err))
      if (intentWritten) {
        const abortEntry = {
          phase: 'abort' as const,
          actorId: cmd.actorId,
          type: cmd.type,
          target: cmd.target,
          error: error.message
        }
        if (overlayId) {
          const overlay = this.overlays.get(overlayId)
          overlay?.recordLog({ seq: 0, at: this.now(), ...abortEntry })
        } else {
          this.journal.append(abortEntry)
        }
      }
      if (!(err instanceof CommandError)) console.error(`command ${cmd.type} failed`, err)
      this.metrics.inc('flow.rejected')
      this.metrics.inc(`flow.rejected.${error.code}`)
      const result: CommandResult<T> = {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details,
        commandId: cmd.id
      }
      this.emit('rejected', { command: cmd, result })
      return result
    } finally {
      this.exitLockGate(implicitLock, cmd.actorId)
    }
  }
}
