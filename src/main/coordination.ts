import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import {
  CommandError,
  fileResource,
  VersionRegistry,
  fold,
  rewind as rewindHelper,
  blame as blameHelper,
  fork as forkHelper,
  type JournalEntry,
  type LockManager,
  type ResourceId,
  type ResourceLock
} from './core/index.ts'

export const TASK_STATES = ['backlog', 'queued', 'in_progress', 'review', 'done', 'cancelled'] as const
export type TaskState = (typeof TASK_STATES)[number]

/** Bumped whenever the persisted board shape changes. */
export const BOARD_SCHEMA_VERSION = 2

/** Snapshot cache interval for event sourcing. */
export const BOARD_SNAPSHOT_INTERVAL = 50

/** Marks tasks the human added from the kanban board rather than an agent. */
export const USER_AUTHOR = 'user'

export interface Task {
  id: string
  title: string
  brief: string
  files: string[]
  state: TaskState
  createdBy: string
  assignee?: string
  /** Free-form labels rendered as chips on the card. */
  tags: string[]
  /** Deadline as an epoch ms timestamp; the board colours it as it approaches. */
  dueAt?: number
  maxSteps: number
  maxReviewIterations: number
  createdAt: number
  updatedAt: number
  /** Optimistic-concurrency version, owned by the Command Bus. */
  version: number
}

export interface BoardState {
  tasks: Map<string, Task>
  manager: string | null
  managerSeenAt: number | null
}

export interface CoordinationSnapshot {
  managerId: string | null
  tasks: Task[]
  /**
   * Live resource locks, read straight from the core lock manager.
   */
  locks: ResourceLock[]
}

/** How long a claimed task's file locks live before a heartbeat is required. */
const TASK_LOCK_TTL_MS = 10 * 60_000
/** A manager that hasn't acted in this long is presumed gone. */
const MANAGER_TTL = 15 * 60_000

/**
 * The board: who is coordinating, and what work exists.
 *
 * Event sourced: state = fold(events), JSON file acts as snapshot cache.
 */
export class CoordinationStore extends EventEmitter {
  private manager: string | null = null
  private managerSeenAt: number | null = null
  private readonly tasks = new Map<string, Task>()
  private readonly locks: LockManager
  private readonly isActorAlive: ((actorId: string) => boolean) | null
  private counter = 0
  private loaded = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private snapshotSeq = 0
  private eventsSinceSnapshot = 0
  readonly versions = new VersionRegistry('task')

  constructor(locks: LockManager, isActorAlive?: (actorId: string) => boolean) {
    super()
    this.locks = locks
    this.isActorAlive = isActorAlive ?? null
  }

  private get file(): string {
    return join(getUserDataDir(), 'workspace-board.json')
  }

  // ---- Event sourcing: Reducer --------------------------------------------

  /**
   * Pure state reduction: state = reduce(state, event).
   */
  static reduce(state: BoardState, event: JournalEntry): BoardState {
    if (event.phase !== 'commit') return state
    const nextTasks = new Map(state.tasks)
    let nextManager = state.manager
    let nextManagerSeenAt = state.managerSeenAt
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const targetId = event.target.startsWith('task:') ? event.target.slice('task:'.length) : event.target

    if (event.type === 'task.create') {
      const task = reviveTask({
        id: targetId === 'new' ? (payload.id as string) || `task-${event.at}-${event.seq}` : targetId,
        title: payload.title,
        brief: payload.brief,
        files: payload.files,
        state: payload.state,
        createdBy: event.actorId,
        assignee: payload.assignee,
        tags: payload.tags,
        dueAt: payload.dueAt,
        maxSteps: payload.maxSteps,
        maxReviewIterations: payload.maxReviewIterations,
        createdAt: event.at,
        updatedAt: event.at,
        version: event.version ?? 1
      })
      if (task) nextTasks.set(task.id, task)
      if (event.actorId === nextManager) nextManagerSeenAt = event.at
    } else if (event.type === 'task.update') {
      const existing = nextTasks.get(targetId)
      if (existing) {
        const updated = { ...existing }
        if (typeof payload.title === 'string' && payload.title.trim()) updated.title = payload.title.trim().slice(0, 200)
        if (typeof payload.brief === 'string') updated.brief = payload.brief.slice(0, 8_000)
        if (payload.tags !== undefined) updated.tags = normalizeTags(payload.tags)
        if (payload.dueAt !== undefined) updated.dueAt = payload.dueAt === null ? undefined : normalizeDue(payload.dueAt)
        if (payload.assignee !== undefined) {
          updated.assignee = typeof payload.assignee === 'string' && payload.assignee.trim() ? payload.assignee.trim() : undefined
        }
        if (typeof payload.state === 'string' && (TASK_STATES as readonly string[]).includes(payload.state)) {
          updated.state = payload.state as TaskState
        }
        updated.updatedAt = event.at
        updated.version = event.version ?? existing.version + 1
        nextTasks.set(targetId, updated)
      }
      if (event.actorId === nextManager) nextManagerSeenAt = event.at
    } else if (event.type === 'task.claim') {
      const existing = nextTasks.get(targetId)
      if (existing) {
        nextTasks.set(targetId, {
          ...existing,
          assignee: event.actorId,
          state: 'in_progress',
          updatedAt: event.at,
          version: event.version ?? existing.version + 1
        })
      }
    } else if (event.type === 'task.delete') {
      nextTasks.delete(targetId)
    } else if (event.type === 'manager.claim') {
      nextManager = event.actorId
      nextManagerSeenAt = event.at
    } else if (event.type === 'manager.release') {
      nextManager = null
      nextManagerSeenAt = null
    }

    return {
      tasks: nextTasks,
      manager: nextManager,
      managerSeenAt: nextManagerSeenAt
    }
  }

  /**
   * Applies an event to this store instance using the reducer.
   */
  applyEvent(event: JournalEntry): void {
    if (event.phase !== 'commit') return
    const current: BoardState = {
      tasks: this.tasks,
      manager: this.manager,
      managerSeenAt: this.managerSeenAt
    }
    const nextState = CoordinationStore.reduce(current, event)
    this.tasks.clear()
    for (const [k, v] of nextState.tasks.entries()) {
      this.tasks.set(k, v)
    }
    this.manager = nextState.manager
    this.managerSeenAt = nextState.managerSeenAt

    if (typeof event.version === 'number' && event.target.startsWith('task:')) {
      const id = event.target.slice('task:'.length)
      if (event.type === 'task.delete') {
        this.versions.forget(id)
      } else {
        this.versions.seed([{ id, version: event.version }])
      }
    }
    if (event.seq > this.snapshotSeq) {
      this.snapshotSeq = event.seq
    }
    this.eventsSinceSnapshot += 1
    if (this.eventsSinceSnapshot >= BOARD_SNAPSHOT_INTERVAL) {
      this.flush()
    }
  }

  /**
   * Folds historical events into state.
   */
  foldEvents(events: Iterable<JournalEntry>, initialState?: BoardState): BoardState {
    const start: BoardState = initialState ?? { tasks: new Map(), manager: null, managerSeenAt: null }
    return fold(events, CoordinationStore.reduce, start)
  }

  // ---- Loading & Snapshot Cache -------------------------------------------

  private ensure(tailEvents?: JournalEntry[]): void {
    if (this.loaded) return
    // Loaded only after the read succeeded: a transient EBUSY/EACCES must not
    // leave an empty board whose next flush() overwrites the real snapshot.
    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    this.loaded = true
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : []
    for (const entry of tasks) {
      const task = reviveTask(entry)
      if (task) this.tasks.set(task.id, task)
    }
    this.snapshotSeq = Number(raw.snapshotSeq) || 0
    this.versions.seed(this.tasks.values())
    const seenAt = Number(raw.managerSeenAt) || 0
    if (typeof raw.managerId === 'string' && raw.managerId && Date.now() - seenAt < MANAGER_TTL) {
      this.manager = raw.managerId
      this.managerSeenAt = seenAt
    }

    // Replay NDJSON journal tail if provided
    if (tailEvents && tailEvents.length > 0) {
      const tailToApply = tailEvents.filter((e) => e.seq > this.snapshotSeq && e.phase === 'commit')
      if (tailToApply.length > 0) {
        const replayed = this.foldEvents(tailToApply, {
          tasks: this.tasks,
          manager: this.manager,
          managerSeenAt: this.managerSeenAt
        })
        this.tasks.clear()
        for (const [k, v] of replayed.tasks.entries()) {
          this.tasks.set(k, v)
        }
        this.manager = replayed.manager
        this.managerSeenAt = replayed.managerSeenAt
        this.versions.seed(this.tasks.values())
        this.snapshotSeq = Math.max(this.snapshotSeq, ...tailToApply.map((e) => e.seq))
      }
    }

    let resetInFlight = false
    for (const task of this.tasks.values()) {
      if (task.state !== 'in_progress') continue
      task.state = 'queued'
      task.assignee = undefined
      resetInFlight = true
    }
    this.pruneStale()
    if (resetInFlight) this.schedulePersist()
  }

  loadWithTail(tailEvents: JournalEntry[]): void {
    this.loaded = false
    this.tasks.clear()
    this.manager = null
    this.managerSeenAt = null
    this.ensure(tailEvents)
  }

  // ---- Event Sourcing Free Features: rewind, blame, replay, fork -----------

  rewind(targetSeq: number, events: Iterable<JournalEntry> = []): CoordinationSnapshot {
    this.ensure()
    const rewoundState = rewindHelper(
      targetSeq,
      events,
      CoordinationStore.reduce,
      { snapshotSeq: 0, state: { tasks: new Map<string, Task>(), manager: null, managerSeenAt: null } }
    )
    return {
      managerId: rewoundState.manager,
      tasks: Array.from(rewoundState.tasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      locks: this.locks.list()
    }
  }

  blame(target: ResourceId, events: Iterable<JournalEntry> = []): JournalEntry[] {
    return blameHelper(target, events)
  }

  replay(events: Iterable<JournalEntry>, fromState?: BoardState): CoordinationSnapshot {
    const start: BoardState = fromState ?? { tasks: new Map(), manager: null, managerSeenAt: null }
    const state = fold(events, CoordinationStore.reduce, start)
    return {
      managerId: state.manager,
      tasks: Array.from(state.tasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      locks: this.locks.list()
    }
  }

  fork(forkId: string, atSeq?: number, events?: Iterable<JournalEntry>): CoordinationSnapshot {
    this.ensure()
    if (typeof atSeq === 'number' && events) {
      return this.rewind(atSeq, events)
    }
    const forkedTasks = forkHelper(forkId, this.tasks)
    return {
      managerId: this.manager,
      tasks: Array.from(forkedTasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      locks: this.locks.list()
    }
  }

  // ---- Persistence --------------------------------------------------------

  private changed(): void {
    this.ensure()
    this.emit('change', this.snapshot())
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flush()
    }, 250)
    this.persistTimer.unref?.()
  }

  private flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.loaded) return
    try {
      writeJsonAtomic(this.file, {
        snapshotSeq: this.snapshotSeq,
        schemaVersion: BOARD_SCHEMA_VERSION,
        tasks: Array.from(this.tasks.values()),
        managerId: this.manager,
        managerSeenAt: this.managerSeenAt
      })
      this.eventsSinceSnapshot = 0
    } catch (err) {
      console.error('failed to persist task board', err)
    }
  }

  private touchManager(agentId: string): void {
    if (agentId === this.manager) this.managerSeenAt = Date.now()
  }

  dispose(): void {
    this.flush()
  }

  private nextTaskId(): string {
    this.counter += 1
    return `task-${Date.now()}-${this.counter}`
  }

  private pruneStale(): void {
    const now = Date.now()
    let mutated = false
    for (const task of this.tasks.values()) {
      if (task.state !== 'in_progress' || !task.assignee) continue
      const assignee = task.assignee
      if (assignee === USER_AUTHOR || assignee === 'user') continue
      if (task.files.length > 0) {
        const stillHeld = task.files.some((path) => this.locks.isHeldBy(fileResource(path), assignee))
        if (stillHeld) continue
      } else if (this.isActorAlive?.(assignee)) {
        continue
      } else if (!this.isActorAlive) {
        continue
      }
      task.state = 'queued'
      task.assignee = undefined
      task.updatedAt = now
      task.version = this.versions.bump(task.id)
      mutated = true
    }
    if (this.manager && this.managerSeenAt !== null && now - this.managerSeenAt > MANAGER_TTL) {
      this.manager = null
      this.managerSeenAt = null
      mutated = true
    }
    if (mutated) {
      this.schedulePersist()
      queueMicrotask(() => this.emit('change', this.snapshot()))
    }
  }

  snapshot(overlayId?: string): CoordinationSnapshot {
    this.ensure()
    this.pruneStale()
    const rawTasks = Array.from(this.tasks.values())
    const tasks = overlayId && this.versions.hasOverlay(overlayId)
      ? rawTasks.map((t) => ({ ...t, version: this.versions.current(t.id, overlayId) }))
      : rawTasks
    return {
      managerId: this.manager,
      tasks: tasks.sort((a, b) => a.createdAt - b.createdAt),
      locks: this.locks.list()
    }
  }

  task(id: string, overlayId?: string): Task | undefined {
    this.ensure()
    const task = this.tasks.get(id)
    if (!task) return undefined
    if (overlayId && this.versions.hasOverlay(overlayId)) {
      return { ...task, version: this.versions.current(id, overlayId) }
    }
    return task
  }

  get managerId(): string | null {
    this.ensure()
    return this.manager
  }

  isManager(agentId: unknown): boolean {
    return typeof agentId === 'string' && agentId.length > 0 && agentId === this.manager
  }

claimManager(agentId: string): { managerId: string; role: 'manager' } {
    this.ensure()
    // A manager silent past MANAGER_TTL is presumed gone; prune first so its
    // expired claim cannot block the next agent with "already assigned".
    this.pruneStale()
    const id = agentId?.trim()
    if (!id) throw new CommandError('invalid', 'agentId is required')
    if (this.manager && this.manager !== id) {
      throw new CommandError('forbidden', 'manager already assigned', { managerId: this.manager })
    }
    this.manager = id
    this.managerSeenAt = Date.now()
    this.eventsSinceSnapshot += 1
    this.emit('change', this.snapshot())
    this.flush()
    return { managerId: id, role: 'manager' }
  }

  releaseManager(agentId: string): void {
    if (!this.manager || agentId !== this.manager) {
      throw new CommandError('forbidden', 'only the current manager may release this role')
    }
    this.manager = null
    this.managerSeenAt = null
    this.eventsSinceSnapshot += 1
    this.changed()
  }

  forceResetManager(): void {
    this.manager = null
    this.managerSeenAt = null
    this.eventsSinceSnapshot += 1
    this.changed()
  }

  createTask(input: {
    title: string
    brief?: string
    files?: unknown
    maxSteps?: unknown
    maxReviewIterations?: unknown
    createdBy: string
    state?: TaskState
    tags?: unknown
    dueAt?: unknown
    assignee?: string
  }, overlayId?: string): Task {
    this.ensure()
    const title = input.title?.trim().slice(0, 200)
    if (!title) throw new CommandError('invalid', 'title is required')
    this.touchManager(input.createdBy)
    const now = Date.now()
    const id = this.nextTaskId()
    const task: Task = {
      id,
      title,
      brief: typeof input.brief === 'string' ? input.brief.slice(0, 8_000) : '',
      files: Array.isArray(input.files)
        ? input.files.filter((p): p is string => typeof p === 'string').slice(0, 50)
        : [],
      state: input.state && TASK_STATES.includes(input.state) ? input.state : 'queued',
      createdBy: input.createdBy,
      assignee: typeof input.assignee === 'string' && input.assignee.trim() ? input.assignee.trim() : undefined,
      tags: normalizeTags(input.tags),
      dueAt: normalizeDue(input.dueAt),
      maxSteps: clamp(Number(input.maxSteps) || 20, 1, 100),
      maxReviewIterations: clamp(Number(input.maxReviewIterations) || 2, 1, 10),
      createdAt: now,
      updatedAt: now,
      version: this.versions.bump(id, overlayId)
    }
    this.tasks.set(task.id, task)
    this.eventsSinceSnapshot += 1
    this.changed()
    return task
  }

  lockExtraFile(taskId: string, agentId: string, path: string, ttlMs?: number, overlayId?: string): ResourceLock {
    this.ensure()
    this.pruneStale()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    const worker = agentId?.trim()
    if (!worker) throw new CommandError('invalid', 'agentId is required')
    if (!this.isManager(worker) && worker !== task.assignee) {
      throw new CommandError('forbidden', 'only the manager or assigned worker may lock extra files')
    }
    if (task.state !== 'in_progress') {
      throw new CommandError('conflict', 'task is not in progress', { task })
    }
    const filePath = path?.trim()
    if (!filePath) throw new CommandError('invalid', 'path is required')
    const resource = fileResource(filePath)
    const lock = this.locks.acquire({
      resource,
      actorId: worker,
      ttlMs: typeof ttlMs === 'number' ? ttlMs : TASK_LOCK_TTL_MS,
      reason: `task ${taskId}`
    })
    if (!task.files.includes(filePath) && !task.files.some((f) => fileResource(f) === resource)) {
      task.files = [...task.files, filePath]
      task.updatedAt = Date.now()
      task.version = this.versions.bump(task.id, overlayId)
      this.eventsSinceSnapshot += 1
      this.changed()
    }
    return lock
  }

  claimTask(taskId: string, agentId: string, overlayId?: string): Task {
    this.ensure()
    this.pruneStale()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    const worker = agentId?.trim()
    if (!worker || worker === this.manager) throw new CommandError('invalid', 'a worker agentId is required')
    if (task.state !== 'queued' && task.state !== 'backlog')
      throw new CommandError('conflict', 'task is not available', { task })

    const taken: string[] = []
    try {
      for (const path of task.files) {
        const resource = fileResource(path)
        this.locks.acquire({ resource, actorId: worker, ttlMs: TASK_LOCK_TTL_MS, reason: `task ${taskId}` })
        taken.push(resource)
      }
    } catch (err) {
      // Roll back what was taken; a failing release must not abort the loop
      // and leak the remaining locks until their 10-minute TTL expires.
      for (const resource of taken) {
        try {
          this.locks.release(resource, worker)
        } catch {
          /* TTL will reclaim it */
        }
      }
      throw err
    }

    task.assignee = worker
    task.state = 'in_progress'
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id, overlayId)
    this.eventsSinceSnapshot += 1
    this.emit('change', this.snapshot(overlayId))
    this.flush()
    return task
  }

  updateTask(taskId: string, agentId: string, state: unknown, overlayId?: string): Task {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    if (!this.isManager(agentId) && agentId !== task.assignee) {
      throw new CommandError('forbidden', 'only the manager or assigned worker may update this task')
    }
    this.touchManager(agentId)
    this.applyState(task, state, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
    return task
  }

  updateTaskAsUser(
    taskId: string,
    patch: {
      state?: unknown
      title?: string
      brief?: string
      tags?: unknown
      dueAt?: unknown
      assignee?: string | null
    },
    actor: { role: 'member' | 'lead'; name: string } = { role: 'member', name: USER_AUTHOR },
    overlayId?: string
  ): Task {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    const owns = task.assignee === actor.name || task.createdBy === USER_AUTHOR
    if (actor.role !== 'lead' && !owns) throw new CommandError('forbidden', 'only the lead may edit other people’s tasks')
    if (actor.role !== 'lead' && patch.assignee !== undefined)
      throw new CommandError('forbidden', 'only the lead may reassign tasks')

    if (patch.state !== undefined) this.applyState(task, patch.state, overlayId)
    if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim().slice(0, 200)
    if (typeof patch.brief === 'string') task.brief = patch.brief.slice(0, 8_000)
    if (patch.tags !== undefined) task.tags = normalizeTags(patch.tags)
    if (patch.dueAt !== undefined) task.dueAt = patch.dueAt === null ? undefined : normalizeDue(patch.dueAt)
    if (patch.assignee !== undefined)
      task.assignee = typeof patch.assignee === 'string' && patch.assignee.trim() ? patch.assignee.trim() : undefined
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
    return task
  }

  private applyState(task: Task, state: unknown, overlayId?: string): void {
    if (typeof state === 'string' && (TASK_STATES as readonly string[]).includes(state)) {
      task.state = state as TaskState
      if (state === 'queued' || state === 'done' || state === 'cancelled') {
        if (state === 'queued') task.assignee = undefined
        this.releaseTaskLocks(task)
      } else if (task.assignee) {
        for (const path of task.files) {
          const resource = fileResource(path)
          if (this.locks.isHeldBy(resource, task.assignee)) this.locks.renew(resource, task.assignee, TASK_LOCK_TTL_MS)
        }
      }
    }
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id, overlayId)
  }

  private releaseTaskLocks(task: Task): void {
    const owner = task.assignee
    for (const path of task.files) {
      const resource = fileResource(path)
      const holder = this.locks.holder(resource)
      if (holder && holder.reason === `task ${task.id}` && (!owner || holder.actorId === owner)) {
        this.locks.release(resource, holder.actorId)
      }
    }
  }

  deleteTask(taskId: string, overlayId?: string): void {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    this.releaseTaskLocks(task)
    this.tasks.delete(taskId)
    this.versions.forget(taskId, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function reviveTask(entry: unknown): Task | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !title) return null
  const now = Date.now()
  return {
    id,
    title,
    brief: typeof raw.brief === 'string' ? raw.brief : '',
    files: Array.isArray(raw.files) ? raw.files.filter((p): p is string => typeof p === 'string') : [],
    state:
      typeof raw.state === 'string' && (TASK_STATES as readonly string[]).includes(raw.state)
        ? (raw.state as TaskState)
        : 'queued',
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : USER_AUTHOR,
    assignee: typeof raw.assignee === 'string' && raw.assignee.trim() ? raw.assignee.trim() : undefined,
    tags: normalizeTags(raw.tags),
    dueAt: normalizeDue(raw.dueAt),
    maxSteps: clamp(Number(raw.maxSteps) || 20, 1, 100),
    maxReviewIterations: clamp(Number(raw.maxReviewIterations) || 2, 1, 10),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    version: Number(raw.version) > 0 ? Number(raw.version) : 1
  }
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const raw of value) {
    const tag = String(raw).trim().replace(/^#/, '')
    if (tag) seen.add(tag.slice(0, 24))
  }
  return Array.from(seen).slice(0, 8)
}

function normalizeDue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const at = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(at) ? at : undefined
}
