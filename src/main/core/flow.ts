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

  implicitLockTtlMs?: number
  maxQueueLength?: number
  rateLimitPerSec?: number
  rateLimitBurst?: number
}
















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


    this.definitions.set(def.type, def as CommandDefinition)
    if (def.handler) {
      try {
        this.register(def.type, {
          requiresLock: def.requiresLock,
          ignoreVersion: def.ignoreVersion,
          transient: def.transient ?? def.handler.transient,
          bypassQueue: def.bypassQueue ?? def.handler.bypassQueue,
          description: def.description,
          extraLocks: def.handler.extraLocks,
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







  private extraLocksOf(cmd: Command): ResourceId[] {
    const handler = this.handlers.get(cmd.type)
    const fn = handler?.extraLocks as ((command: Command) => ResourceId[]) | undefined
    if (!fn) return []
    try {
      return fn(cmd) ?? []
    } catch {
      return []
    }
  }

  private lanesOf(command: Command): string[] {
    const parsed = parseResource(command.target)
    const primary = parsed ? (parsed.scheme === 'file' ? fileResource(parsed.id) : command.target) : command.target
    const lanes = new Set<string>([primary])
    for (const extra of this.extraLocksOf(command)) lanes.add(extra)
    return [...lanes]
  }

  private lanesOfCommands(commands: Command[]): string[] {
    const lanes = new Set<string>()
    for (const cmd of commands) for (const lane of this.lanesOf(cmd)) lanes.add(lane)
    return [...lanes].sort()
  }


  stats(): ReturnType<MetricsRegistry['snapshot']> & { queueDepth: number; busyLanes: number } {
    return {
      ...this.metrics.snapshot(),
      queueDepth: this.pQueue.totalLength,
      busyLanes: this.pQueue.busyLaneCount
    }
  }










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


  private assertUnlockedFor(cmd: Command): void {
    for (const resource of [cmd.target, ...this.extraLocksOf(cmd)]) {
      if (!this.locks.isLockedByOther(resource, cmd.actorId)) continue
      const lock = this.locks.holder(resource)
      throw new CommandError('locked', `${resource} is locked by ${lock?.actorId}`, { lock })
    }
  }


  private takeImplicitLockFor(cmd: Command, ttlMs: number | undefined, reason: string): ResourceId[] {
    const acquired: ResourceId[] = []
    try {
      for (const resource of [cmd.target, ...this.extraLocksOf(cmd)]) {
        if (this.locks.isHeldBy(resource, cmd.actorId)) continue
        this.locks.acquire({
          resource,
          actorId: cmd.actorId,
          ttlMs: ttlMs ?? this.implicitLockTtl,
          reason,
          implicit: true
        })
        acquired.push(resource)
      }
    } catch (error) {
      // All-or-nothing. A throw partway (an extra resource that fails
      // validation, or one taken between the caller's check and here) used to
      // leave the locks already taken in this loop held by nobody's `finally`
      // — the caller only releases what was *returned*. They would then sit
      // there until their TTL expired, and every command touching those
      // resources meanwhile came back `locked` with no holder able to release.
      for (const resource of acquired) this.exitLockGate(resource, cmd.actorId)
      throw error
    }
    return acquired
  }

  private exitLockGate(lock: ResourceId | null, actorId: string): void {
    if (!lock) return
    try {
      if (this.locks.holder(lock)?.implicit === true) this.locks.release(lock, actorId)
    } catch {

    }
  }


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


  private resolveResultVersion(target: ResourceId, overlayId: string | undefined, data: unknown, fallback: number): number {
    const created = (data as { version?: unknown } | null)?.version
    return this.versionOf(target, overlayId) || (typeof created === 'number' ? created : 0) || fallback
  }



  cancel(commandId: string, reason = 'cancelled'): boolean {
    const ctrl = this.cancellations.get(commandId)
    if (!ctrl) return false
    ctrl.abort(reason)
    this.cancellations.delete(commandId)
    this.metrics.inc('flow.cancelled')
    this.emit('cancelled', { commandId, reason })
    return true
  }



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



  submit<T = unknown>(command: Command, options?: { overlayId?: string }): Promise<CommandResult<T>> {



    const cmd: Command = { ...command }
    this.cmdCounter += 1
    const commandId = cmd.id || `cmd-${this.now()}-${this.cmdCounter}`
    cmd.id = commandId
    const submittedAt = this.now()
    this.metrics.inc('flow.submitted')


    if (cmd.idempotencyKey) {
      const cached = this.idempotency.get<T>(cmd.idempotencyKey)
      if (cached) {
        if (cached.result) return Promise.resolve(cached.result)
        if (cached.inFlight) return cached.inFlight
      }
    }





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


    const abortCtrl = new AbortController()
    this.cancellations.set(commandId, abortCtrl)






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








  async submitNested<T = unknown>(
    command: Command,
    options?: { overlayId?: string; signal?: AbortSignal; nested?: boolean }
  ): Promise<CommandResult<T>> {
    if (options?.nested === true) {
      return this.apply<T>(command, () => {}, options.overlayId, options.signal)
    }
    return this.submit<T>(command, options)
  }



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
    const rollbackStack: Array<() => void | Promise<void>> = []

    try {
      if (signal?.aborted) throw new CommandError('cancelled', 'transaction cancelled before execution')



      const primaryActor = this.actors.require(primaryActorId)
      this.actors.touch(primaryActor.id)

      const validated = commands.map((rawCmd) => this.prepare(rawCmd))
      const validatedCommands: Command[] = validated.map((v) => v.command)



      if (!overlayId) {
        for (const v of validated) {
          if (v.handler.requiresLock !== false) this.assertUnlockedFor(v.command)
        }
        for (const v of validated) {
          const cmd = v.command
          if (v.handler.requiresLock === false) continue
          for (const resource of this.takeImplicitLockFor(cmd, options?.implicitLockTtlMs, `transact:${cmd.type}`)) {
            if (!implicitLocks.includes(resource)) implicitLocks.push(resource)
          }
        }
      }


      const simulatedVersions = new Map<ResourceId, number>()
      for (const v of validated) {
        const cmd = v.command
        const currentVersion = simulatedVersions.has(cmd.target)
          ? simulatedVersions.get(cmd.target)!
          : this.versionOf(cmd.target, overlayId)
        this.assertVersionGate(v.handler, cmd, currentVersion)
        simulatedVersions.set(cmd.target, currentVersion + 1)
      }


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


        this.journal.append(intentEntry)
      }
      intentWritten = true


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
          rollback: (undo: () => void | Promise<void>) => void
          unblock: () => void
        }) => unknown

        const data = await apply({
          command: cmd,
          actor,
          currentVersion,
          overlayId,
          signal,
          rollback: (undo) => {
            if (typeof undo === 'function') rollbackStack.push(undo)
          },
          unblock: () => {}
        })
        const version = this.resolveResultVersion(cmd.target, overlayId, data, currentVersion)

        const cmdRes: CommandResult = { ok: true, seq: this.journal.lastSeq + 1, version, data }
        detailedResults.push(cmdRes)
        dataResults.push(data)

        if (overlayId) {
          const overlay = this.overlays.get(overlayId)
          overlay?.set(cmd.target, data, version)
        }
      }


      let commitSeq = this.journal.lastSeq + 1
      const commitEntry = {
        phase: 'commit' as const,
        actorId: primaryActorId,
        commandId: txId,
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
      for (let i = rollbackStack.length - 1; i >= 0; i -= 1) {
        try {
          await rollbackStack[i]()
        } catch (rollbackError) {
          // Preserve the original transaction failure while making a broken
          // compensator visible to diagnostics.
          console.error('flow.transact rollback failed', rollbackError)
        }
      }
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



  private async apply<T>(
    command: Command,
    unblock: () => void = () => {},
    overlayId?: string,
    signal?: AbortSignal
  ): Promise<CommandResult<T>> {
    let implicitLocks: ResourceId[] = []
    let intentWritten = false
    let cmd = command
    try {
      if (signal?.aborted) throw new CommandError('cancelled', 'command cancelled before execution')



      const prepared = this.prepare(cmd)
      const { handler } = prepared
      cmd = prepared.command

      const actor = this.actors.require(cmd.actorId)
      this.actors.touch(actor.id)


      if (!overlayId && handler.requiresLock !== false) {
        this.assertUnlockedFor(cmd)



        if (handler.transient !== true) {
          implicitLocks = this.takeImplicitLockFor(cmd, undefined, cmd.type)
        }
      }


      const currentVersion = this.versionOf(cmd.target, overlayId)
      this.assertVersionGate(handler, cmd, currentVersion)


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


      const apply = handler.apply as (ctx: {
        command: Command
        actor: typeof actor
        currentVersion: number
        overlayId?: string
        signal?: AbortSignal
        rollback: (undo: () => void | Promise<void>) => void
        unblock: () => void
      }) => unknown

      const data = (await apply({ command: cmd, actor, currentVersion, overlayId, signal, rollback: () => {}, unblock })) as T
      const version = this.resolveResultVersion(cmd.target, overlayId, data, currentVersion)

      let commitSeq = this.journal.lastSeq + 1
      const commitEntry = {
        phase: 'commit' as const,
        actorId: actor.id,
        commandId: cmd.id,
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
      for (const lock of implicitLocks) this.exitLockGate(lock, cmd.actorId)
    }
  }
}
