import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from '../storage.ts'
import { getUserDataDir } from '../userData.ts'
import { CommandError, VersionRegistry } from '../core/index.ts'
import {
  DISPATCH_STATES,
  MESSAGE_TYPES,
  TASK_STATUSES,
  isHandle,
  type Dispatch,
  type Gate,
  type Message,
  type MessageType,
  type OrcTask,
  type OrcTaskStatus,
  type OrchestrationSnapshot,
  type Outcome,
  type Run
} from './types.ts'


export const ORCHESTRATION_SCHEMA_VERSION = 1






const MAX_MESSAGES = 2_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_INBOX_SCAN = 2_000

function capBody(body: string): string {
  const text = String(body ?? '')
  if (Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) return text
  // Byte-accurate truncation that never splits a UTF-8 sequence.
  let end = Math.min(text.length, MAX_BODY_BYTES)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > MAX_BODY_BYTES) {
    end = Math.floor(end / 2)
  }
  // Grow back to the exact limit without overshooting.
  while (end < text.length && Buffer.byteLength(text.slice(0, end + 1), 'utf8') <= MAX_BODY_BYTES) {
    end += 1
  }
  return text.slice(0, end)
}


const PERSIST_DEBOUNCE_MS = 250

interface PersistedShape {
  schemaVersion: number
  runs: Run[]
  tasks: OrcTask[]
  dispatches: Dispatch[]
  messages: Message[]
  gates: Gate[]
}








function emptyShape(): PersistedShape {
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    runs: [],
    tasks: [],
    dispatches: [],
    messages: [],
    gates: []
  }
}















export class OrchestrationStore extends EventEmitter {
  readonly runVersions = new VersionRegistry('run')
  readonly taskVersions = new VersionRegistry('orctask')
  readonly dispatchVersions = new VersionRegistry('dispatch')
  readonly gateVersions = new VersionRegistry('gate')

  private runs = new Map<string, Run>()
  private tasks = new Map<string, OrcTask>()
  private dispatches = new Map<string, Dispatch>()
  private gates = new Map<string, Gate>()
  private messages: Message[] = []
  private messageIndex = new Map<string, Message>()
  private repliesByAskId = new Map<string, Message>()
  private counter = 0
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0
  private syncFlushedSeq = 0
  private readonly file: string
  private readonly now: () => number

  constructor(options: { file?: string; now?: () => number } = {}) {
    super()
    this.setMaxListeners(0)
    this.now = options.now ?? Date.now
    this.file = options.file ?? join(getUserDataDir(), 'orchestration.json')
    this.load()
  }



  private load(): void {
    const data = readStoreJson<PersistedShape>(this.file, emptyShape())
    for (const run of data.runs ?? []) this.runs.set(run.id, run)
    for (const task of data.tasks ?? []) this.tasks.set(task.id, task)
    for (const dispatch of data.dispatches ?? []) this.dispatches.set(dispatch.id, dispatch)
    for (const gate of data.gates ?? []) this.gates.set(gate.id, gate)
    this.messages = [...(data.messages ?? [])]
    this.messageIndex.clear()
    this.repliesByAskId.clear()
    for (const m of this.messages) {
      this.messageIndex.set(m.id, m)
      if (m.type === 'reply' && m.replyTo) {
        this.repliesByAskId.set(m.replyTo, m)
      }
    }
    this.runVersions.seed(this.runs.values())
    this.taskVersions.seed(this.tasks.values())
    this.dispatchVersions.seed(this.dispatches.values())
    this.gateVersions.seed(this.gates.values())

    const ids = [
      ...this.runs.keys(),
      ...this.tasks.keys(),
      ...this.dispatches.keys(),
      ...this.gates.keys(),
      ...this.messages.map((m) => m.id)
    ]
    for (const id of ids) {
      const n = Number(id.slice(id.lastIndexOf('-') + 1))
      if (Number.isFinite(n) && n > this.counter) this.counter = n
    }
  }

  private payload(): PersistedShape {
    return {
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      runs: [...this.runs.values()],
      tasks: [...this.tasks.values()],
      dispatches: [...this.dispatches.values()],
      messages: this.messages,
      gates: [...this.gates.values()]
    }
  }















  private save(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flushAsync()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }





  private flushAsync(): void {
    this.writeSeq += 1
    const seq = this.writeSeq
    const snapshot = this.payload()
    this.writeChain = this.writeChain
      .catch(() => {

      })
      .then(async () => {
        if (seq <= this.syncFlushedSeq) return
        try {
          await writeJsonAtomicAsync(this.file, snapshot)
        } catch (err) {
          console.error('failed to persist orchestration state', err)
        }
      })
      .catch((err) => console.error('orchestration flushAsync chain broke', err))
  }


  flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      writeJsonAtomic(this.file, this.payload())
      this.syncFlushedSeq = this.writeSeq
    } catch (err) {
      console.error('failed to flush orchestration state', err)
    }
  }

  private id(prefix: string): string {
    this.counter += 1
    return `${prefix}-${this.counter}`
  }



  createRun(input: { objective: string; coordinator: string }): Run {
    const objective = String(input.objective ?? '').trim()
    if (!objective) throw new CommandError('invalid', 'a run needs an objective')
    const id = this.id('run')
    const run: Run = {
      id,
      objective,
      coordinator: input.coordinator,
      createdAt: this.now(),
      version: this.runVersions.bump(id)
    }
    this.runs.set(id, run)
    this.save()
    this.emit('changed', { kind: 'run', id })
    return run
  }

  closeRun(id: string): Run {
    const run = this.requireRun(id)
    run.closedAt = this.now()
    run.version = this.runVersions.bump(id)
    this.save()
    this.emit('changed', { kind: 'run', id })
    return run
  }

  requireRun(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new CommandError('not_found', `no run "${id}" — call run-create first`)
    return run
  }










  listRuns(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt || sequenceOf(b.id) - sequenceOf(a.id))
  }


  activeRun(): Run | undefined {
    return this.listRuns().find((r) => !r.closedAt)
  }



  createTask(input: {
    runId: string
    title?: string
    spec: string
    deps?: string[]
    images?: string[]
    createdBy: string
  }): OrcTask {
    const run = this.requireRun(input.runId)
    const spec = String(input.spec ?? '').trim()
    if (!spec) throw new CommandError('invalid', 'a task needs a spec')
    const deps = (input.deps ?? []).map(String)
    for (const dep of deps) {
      const depTask = this.tasks.get(dep)
      if (!depTask) throw new CommandError('not_found', `dependency "${dep}" is not a task`)
      if (depTask.runId !== run.id) {
        throw new CommandError('invalid', `dependency "${dep}" belongs to a different run`)
      }
    }
    const id = this.id('otask')
    const satisfied = deps.every((dep) => this.tasks.get(dep)?.status === 'completed')
    const task: OrcTask = {
      id,
      runId: run.id,

      title: String(input.title ?? '').trim() || firstLine(spec),
      spec,
      deps,
      ...(input.images?.length ? { images: input.images.map(String) } : {}),
      status: satisfied ? 'ready' : 'pending',
      createdBy: input.createdBy,
      createdAt: this.now(),
      updatedAt: this.now(),
      version: this.taskVersions.bump(id)
    }
    this.tasks.set(id, task)
    this.save()
    this.emit('changed', { kind: 'task', id })
    return task
  }

  requireTask(id: string): OrcTask {
    const task = this.tasks.get(id)
    if (!task) throw new CommandError('not_found', `no task "${id}" — call task-list first`)
    return task
  }

  listTasks(filter: { runId?: string; status?: OrcTaskStatus; ready?: boolean } = {}): OrcTask[] {
    let all = [...this.tasks.values()]
    if (filter.runId) all = all.filter((t) => t.runId === filter.runId)
    if (filter.status) all = all.filter((t) => t.status === filter.status)
    if (filter.ready) all = all.filter((t) => this.isReady(t))
    return all.sort((a, b) => a.createdAt - b.createdAt)
  }


  private isReady(task: OrcTask): boolean {
    if (task.status !== 'pending' && task.status !== 'ready') return false
    return task.deps.every((dep) => this.tasks.get(dep)?.status === 'completed')
  }

  updateTask(id: string, patch: { status?: OrcTaskStatus; title?: string; spec?: string }): OrcTask {
    const task = this.requireTask(id)
    if (patch.status !== undefined) {
      if (!TASK_STATUSES.includes(patch.status)) {
        throw new CommandError('invalid', `status must be one of ${TASK_STATUSES.join(', ')}`)
      }
      task.status = patch.status
    }
    if (patch.title !== undefined) task.title = String(patch.title)
    if (patch.spec !== undefined) task.spec = String(patch.spec)
    task.updatedAt = this.now()
    task.version = this.taskVersions.bump(id)
    this.promoteReady()
    this.save()
    this.emit('changed', { kind: 'task', id })
    return task
  }






  private promoteReady(): string[] {
    const promoted: string[] = []
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && this.isReady(task)) {
        task.status = 'ready'
        task.updatedAt = this.now()
        task.version = this.taskVersions.bump(task.id)
        promoted.push(task.id)
      }
    }
    return promoted
  }



  createDispatch(input: {
    taskId: string
    terminalId: string
    agent: string
    preamble: string
  }): Dispatch {
    const task = this.requireTask(input.taskId)
    if (task.status === 'completed') {
      throw new CommandError('conflict', `task "${task.id}" is already completed`)
    }
    const open = this.listDispatches({ taskId: task.id }).find((d) => d.state === 'running')
    if (open) {
      throw new CommandError('conflict', `task "${task.id}" already has a running dispatch`, {
        dispatchId: open.id,
        terminalId: open.terminalId
      })
    }
    const busyTerminal = this.dispatchForTerminal(input.terminalId)
    if (busyTerminal) {
      throw new CommandError('conflict', `terminal "${input.terminalId}" is already running dispatch ${busyTerminal.id}`)
    }
    const id = this.id('disp')
    const dispatch: Dispatch = {
      id,
      runId: task.runId,
      taskId: task.id,
      terminalId: input.terminalId,
      agent: input.agent,
      state: 'running',
      preamble: input.preamble,
      startedAt: this.now(),
      version: this.dispatchVersions.bump(id)
    }
    this.dispatches.set(id, dispatch)
    task.status = 'dispatched'
    task.updatedAt = this.now()
    task.version = this.taskVersions.bump(task.id)
    this.save()
    this.emit('changed', { kind: 'dispatch', id })
    return dispatch
  }

  requireDispatch(id: string): Dispatch {
    const dispatch = this.dispatches.get(id)
    if (!dispatch) throw new CommandError('not_found', `no dispatch "${id}"`)
    return dispatch
  }

  listDispatches(filter: { runId?: string; taskId?: string; terminalId?: string } = {}): Dispatch[] {
    let all = [...this.dispatches.values()]
    if (filter.runId) all = all.filter((d) => d.runId === filter.runId)
    if (filter.taskId) all = all.filter((d) => d.taskId === filter.taskId)
    if (filter.terminalId) all = all.filter((d) => d.terminalId === filter.terminalId)
    return all.sort((a, b) => a.startedAt - b.startedAt)
  }


  dispatchForTerminal(terminalId: string): Dispatch | undefined {
    return this.listDispatches({ terminalId }).find((d) => d.state === 'running')
  }





  settleDispatch(id: string, outcome: Outcome, filesModified?: string[]): { dispatch: Dispatch; task: OrcTask; promoted: string[] } {
    const dispatch = this.requireDispatch(id)
    if (dispatch.state !== 'running') {
      throw new CommandError('conflict', `dispatch "${id}" already settled as ${dispatch.outcome ?? dispatch.state}`)
    }
    dispatch.state = 'settled'
    dispatch.outcome = outcome
    dispatch.settledAt = this.now()
    if (filesModified) dispatch.filesModified = filesModified
    dispatch.version = this.dispatchVersions.bump(id)

    const task = this.requireTask(dispatch.taskId)
    task.status = outcome === 'succeeded' ? 'completed' : 'failed'
    task.outcome = outcome
    task.updatedAt = this.now()
    task.version = this.taskVersions.bump(task.id)

    const promoted = this.promoteReady()
    this.save()
    this.emit('changed', { kind: 'dispatch', id })
    return { dispatch, task, promoted }
  }

  setDispatchState(id: string, state: 'retained' | 'released'): Dispatch {
    const dispatch = this.requireDispatch(id)
    if (dispatch.state === 'running') {
      throw new CommandError('conflict', `dispatch "${id}" is still running — stop it or wait for worker_done`)
    }
    if (!DISPATCH_STATES.includes(state)) throw new CommandError('invalid', `unknown dispatch state "${state}"`)
    dispatch.state = state
    dispatch.version = this.dispatchVersions.bump(id)
    this.save()
    this.emit('changed', { kind: 'dispatch', id })
    return dispatch
  }






  unaccountedDispatches(runId?: string): Dispatch[] {
    return this.listDispatches(runId ? { runId } : {}).filter((d) => d.state === 'settled')
  }



  send(input: {
    runId: string
    type: MessageType
    from: string
    to: string
    subject?: string
    body?: string
    taskId?: string
    dispatchId?: string
    outcome?: Outcome
    filesModified?: string[]
    images?: string[]
    options?: string[]
    replyTo?: string
  }): Message {
    if (!MESSAGE_TYPES.includes(input.type)) {
      throw new CommandError('invalid', `type must be one of ${MESSAGE_TYPES.join(', ')}`)
    }
    if (input.replyTo && !this.messageById(input.replyTo)) {
      throw new CommandError('not_found', `no message "${input.replyTo}" to reply to`)
    }
    const run = this.requireRun(input.runId)
    const message: Message = {
      id: this.id('msg'),
      runId: run.id,
      type: input.type,
      from: input.from,


      to: String(input.to || '@coordinator'),
      subject: String(input.subject ?? '').trim().slice(0, 500) || defaultSubject(input.type, input.taskId),
      body: capBody(String(input.body ?? '')),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.filesModified ? { filesModified: input.filesModified } : {}),
      ...(input.images?.length ? { images: input.images.map(String) } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: this.now(),
      ackedBy: []
    }
    this.messages.push(message)
    this.messageIndex.set(message.id, message)
    if (message.type === 'reply' && message.replyTo) {
      this.repliesByAskId.set(message.replyTo, message)
    }
    if (this.messages.length > MAX_MESSAGES) {
      // Unread mail is evicted last, but it is still evicted. The previous
      // shape fell back to "keep every unacked message" once they alone
      // exceeded the cap, which is not a cap at all: a fleet where nobody runs
      // `orc check` grew this array — and the file behind it — without bound,
      // and paid two filters, a sort and two Map rebuilds on every single
      // message from then on.
      const unacked = this.messages.filter((m) => m.ackedBy.length === 0)
      if (unacked.length >= MAX_MESSAGES) {
        this.messages = unacked.slice(-MAX_MESSAGES)
      } else {
        const spare = MAX_MESSAGES - unacked.length
        this.messages = [
          ...this.messages.filter((m) => m.ackedBy.length > 0).slice(-spare),
          ...unacked
        ].sort((a, b) => a.createdAt - b.createdAt)
      }
      this.messageIndex.clear()
      this.repliesByAskId.clear()
      for (const m of this.messages) {
        this.messageIndex.set(m.id, m)
        if (m.type === 'reply' && m.replyTo) {
          this.repliesByAskId.set(m.replyTo, m)
        }
      }
    }
    this.save()
    this.emit('message', message)
    this.emit('changed', { kind: 'message', id: message.id })
    return message
  }










  private addressingContext(actorId: string): Map<string, { idle: boolean; agents: Set<string> }> {
    const byRun = new Map<string, { idle: boolean; agents: Set<string> }>()
    for (const run of this.runs.keys()) byRun.set(run, { idle: true, agents: new Set() })
    for (const dispatch of this.dispatches.values()) {
      const entry = byRun.get(dispatch.runId)
      if (!entry || dispatch.state !== 'running') continue
      entry.idle = false


      if (dispatch.terminalId === actorId) entry.agents.add(dispatch.agent)
    }
    return byRun
  }


  private addresses(
    message: Message,
    actorId: string,
    run: Run | undefined,
    context: Map<string, { idle: boolean; agents: Set<string> }>
  ): boolean {
    const to = message.to
    if (to === actorId) return true
    if (!isHandle(to)) return false
    if (to === '@all') return true
    if (to === '@coordinator') return run?.coordinator === actorId
    const entry = context.get(message.runId)
    if (to === '@idle') return entry?.idle ?? true

    return entry?.agents.has(to.slice(1)) ?? false
  }






  inbox(
    actorId: string,
    filter: { runId?: string; types?: MessageType[]; includeAcked?: boolean; limit?: number } = {}
  ): Message[] {
    const limit = Math.min(filter.limit ?? 50, MAX_INBOX_SCAN)
    const context = this.addressingContext(actorId)
    const types = filter.types?.length ? new Set(filter.types) : null
    const found: Message[] = []



    for (const message of this.messages.slice(-MAX_INBOX_SCAN)) {
      if (found.length >= limit) break
      if (filter.runId && message.runId !== filter.runId) continue
      if (types && !types.has(message.type)) continue
      if (!filter.includeAcked && message.ackedBy.includes(actorId)) continue


      if (message.from === actorId && !isHandle(message.to)) continue
      if (this.addresses(message, actorId, this.runs.get(message.runId), context)) found.push(message)
    }
    return found
  }

  ack(id: string, actorId: string): Message {
    const message = this.messageIndex.get(id) ?? this.messages.find((m) => m.id === id)
    if (!message) throw new CommandError('not_found', `no message "${id}"`)
    if (!message.ackedBy.includes(actorId)) {
      message.ackedBy.push(actorId)
      this.save()
      this.emit('changed', { kind: 'message', id })
    }
    return message
  }


  replyTo(askId: string): Message | undefined {
    return this.repliesByAskId.get(askId) ?? this.messages.find((m) => m.type === 'reply' && m.replyTo === askId)
  }

  messageById(id: string): Message | undefined {
    return this.messageIndex.get(id) ?? this.messages.find((m) => m.id === id)
  }

  listMessages(filter: { runId?: string; limit?: number } = {}): Message[] {
    const capped = Math.min(filter.limit ?? 200, MAX_INBOX_SCAN)
    const all = filter.runId ? this.messages.filter((m) => m.runId === filter.runId) : this.messages
    return all.slice(-capped)
  }



  createGate(input: {
    runId: string
    taskId?: string
    question: string
    options?: string[]
    createdBy: string
  }): Gate {
    const run = this.requireRun(input.runId)
    const question = String(input.question ?? '').trim()
    if (!question) throw new CommandError('invalid', 'a gate needs a question')
    const id = this.id('gate')
    const gate: Gate = {
      id,
      runId: run.id,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      question,
      options: (input.options ?? []).map(String),
      createdBy: input.createdBy,
      createdAt: this.now(),
      version: this.gateVersions.bump(id)
    }
    this.gates.set(id, gate)

    if (input.taskId) {
      const task = this.tasks.get(input.taskId)
      if (!task) throw new CommandError('not_found', `no task "${input.taskId}" — call task-list first`)
      task.status = 'blocked'
      task.updatedAt = this.now()
      task.version = this.taskVersions.bump(task.id)
    }
    this.save()
    this.emit('changed', { kind: 'gate', id })
    return gate
  }

  requireGate(id: string): Gate {
    const gate = this.gates.get(id)
    if (!gate) throw new CommandError('not_found', `no gate "${id}"`)
    return gate
  }

  resolveGate(id: string, resolution: string): Gate {
    const gate = this.requireGate(id)
    if (gate.resolvedAt) throw new CommandError('conflict', `gate "${id}" is already resolved as "${gate.resolution}"`)
    if (gate.options.length && !gate.options.includes(resolution)) {
      throw new CommandError('invalid', `resolution must be one of ${gate.options.join(', ')}`)
    }
    gate.resolution = resolution
    gate.resolvedAt = this.now()
    gate.version = this.gateVersions.bump(id)
    if (gate.taskId) {
      const task = this.tasks.get(gate.taskId)


      if (task && task.status === 'blocked') {
        task.status = this.isReady({ ...task, status: 'pending' }) ? 'ready' : 'pending'
        task.updatedAt = this.now()
        task.version = this.taskVersions.bump(task.id)
      }
    }
    this.save()
    this.emit('changed', { kind: 'gate', id })
    return gate
  }

  listGates(filter: { runId?: string; open?: boolean } = {}): Gate[] {
    let all = [...this.gates.values()]
    if (filter.runId) all = all.filter((g) => g.runId === filter.runId)
    if (filter.open) all = all.filter((g) => !g.resolvedAt)
    return all.sort((a, b) => a.createdAt - b.createdAt)
  }



  snapshot(runId?: string): OrchestrationSnapshot {
    return {
      runs: this.listRuns(),
      tasks: this.listTasks(runId ? { runId } : {}),
      dispatches: this.listDispatches(runId ? { runId } : {}),
      messages: this.listMessages(runId ? { runId } : {}),
      gates: this.listGates(runId ? { runId } : {})
    }
  }

  reset(what: { tasks?: boolean; messages?: boolean; all?: boolean }): void {
    if (what.all || what.tasks) {
      this.tasks.clear()
      this.dispatches.clear()
      this.gates.clear()
    }
    if (what.all || what.messages) {
      this.messages = []
      this.messageIndex.clear()
      this.repliesByAskId.clear()
    }
    if (what.all) this.runs.clear()
    this.save()
    this.emit('changed', { kind: 'reset', id: '*' })
  }

  dispose(): void {
    this.flush()
    this.removeAllListeners()
  }
}


function sequenceOf(id: string): number {
  const n = Number(id.slice(id.lastIndexOf('-') + 1))
  return Number.isFinite(n) ? n : 0
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim()
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

function defaultSubject(type: MessageType, taskId?: string): string {
  const suffix = taskId ? ` ${taskId}` : ''
  switch (type) {
    case 'worker_done':
      return `worker_done${suffix}`
    case 'escalation':
      return `escalation${suffix}`
    case 'heartbeat':
      return `heartbeat${suffix}`
    case 'ask':
      return `question${suffix}`
    case 'reply':
      return 'reply'
    case 'dispatch':
      return `dispatch${suffix}`
    default:
      return 'note'
  }
}
