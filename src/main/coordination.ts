import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from './storage.ts'
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
import { TASK_LOCK_TTL_MS, TaskLockManager } from './taskLockManager.ts'
import { notifyPersistError } from './persistNotifier.ts'
export { TASK_LOCK_TTL_MS } from './taskLockManager.ts'

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
  private readonly taskLocks: TaskLockManager
  private readonly isActorAlive: ((actorId: string) => boolean) | null
  private counter = 0
  private loaded = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private snapshotSeq = 0
  private eventsSinceSnapshot = 0
  /**
   * Async persistence plumbing (same pattern as CanvasStore): the debounced /
   * interval flushes must not fsync on the Electron main thread, but two
   * overlapping atomic writes could rename in the wrong order and leave an
   * OLDER board file behind a newer one. Writes are chained, and a durable
   * (shutdown) flush marks its seq so queued older copies skip themselves.
   */
  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0
  private syncFlushedSeq = 0
  /** Bumped by every state mutation; invalidates the cached sorted snapshot. */
  private boardRevision = 0
  private sortedCache: { rev: number; tasks: Task[] } | null = null
  /** Read-path prune throttle: agents poll /tasks far faster than claims rot. */
  private lastReadPruneAt = 0
  readonly versions = new VersionRegistry('task')

  constructor(locks: LockManager, isActorAlive?: (actorId: string) => boolean) {
    super()
    this.locks = locks
    this.taskLocks = new TaskLockManager(locks)
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
    this.boardRevision += 1
    this.eventsSinceSnapshot += 1
    if (this.eventsSinceSnapshot >= BOARD_SNAPSHOT_INTERVAL) {
      // Async: this fires from the journal write path, which runs on the main
      // thread between keystrokes and pty chunks — never block it on a fsync.
      this.flushAsync()
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
      // Same bookkeeping as pruneStale: without a version bump + updatedAt, a
      // client holding the pre-restart version sees no conflict and silently
      // overwrites the reset (lost update against its own stale copy).
      task.updatedAt = Date.now()
      task.version = this.versions.bump(task.id)
      resetInFlight = true
    }
    this.pruneStale()
    this.boardRevision += 1
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
    this.boardRevision += 1
    this.emit('change', this.snapshot())
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flushAsync()
    }, 250)
    this.persistTimer.unref?.()
  }

  /** The current board state as the on-disk snapshot payload. */
  private payloadForPersist(): Record<string, unknown> {
    return {
      snapshotSeq: this.snapshotSeq,
      schemaVersion: BOARD_SCHEMA_VERSION,
      tasks: Array.from(this.tasks.values()),
      managerId: this.manager,
      managerSeenAt: this.managerSeenAt
    }
  }

  /**
   * Durable, blocking write. Shutdown only (`dispose` / before-quit): Electron
   * must not tear the process down mid-rename, so here blocking is the point.
   */
  private flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.loaded) return
    try {
      writeJsonAtomic(this.file, this.payloadForPersist())
      // The newest state is now on disk; queued async copies are stale.
      this.syncFlushedSeq = this.writeSeq
      this.eventsSinceSnapshot = 0
    } catch (err) {
      notifyPersistError('board', err)
    }
  }

  /**
   * The periodic write, off the event loop's critical path: no fsync on the
   * main thread, same crash-safe temp+rename file as `flush`. Chained so two
   * overlapping writes cannot rename an older snapshot over a newer one, and
   * seq-guarded against racing a shutdown `flush` (PERF-board-async).
   */
  private flushAsync(): void {
    if (!this.loaded) return
    this.writeSeq += 1
    const seq = this.writeSeq
    const snapshot = this.payloadForPersist()
    this.writeChain = this.writeChain
      .catch(() => {
        /* a failed write must not strand the chain */
      })
      .then(async () => {
        // A durable flush landed after this copy was queued — it is newer.
        if (seq <= this.syncFlushedSeq) return
        try {
          await writeJsonAtomicAsync(this.file, snapshot)
        } catch (err) {
          notifyPersistError('board', err)
          return
        }
        // An in-flight rename cannot be aborted: if the shutdown flush ran
        // while this write was executing, the older snapshot may have won.
        // Memory holds the newest state — put it back on disk synchronously.
        if (seq <= this.syncFlushedSeq) {
          try {
            writeJsonAtomic(this.file, this.payloadForPersist())
            this.syncFlushedSeq = this.writeSeq
          } catch (err) {
            notifyPersistError('board', err)
          }
        } else {
          this.eventsSinceSnapshot = 0
        }
      })
      .catch((err) => notifyPersistError('board', err))
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
        if (this.taskLocks.isTaskLocksHeld(task, assignee)) continue
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
      this.boardRevision += 1
      this.schedulePersist()
      queueMicrotask(() => this.emit('change', this.snapshot()))
    }
  }

  snapshot(overlayId?: string): CoordinationSnapshot {
    this.ensure()
    // pruneStale on every read made each status poll a potential write + an
    // extra whole-board broadcast; agents poll /tasks in a tight loop. Claims
    // only rot on the scale of minutes, so a read-path sweep at most every
    // 2s is indistinguishable — mutators still prune eagerly.
    const now = Date.now()
    if (now - this.lastReadPruneAt >= 2_000) {
      this.lastReadPruneAt = now
      this.pruneStale()
    }
    let tasks: Task[]
    if (!overlayId && this.sortedCache && this.sortedCache.rev === this.boardRevision) {
      tasks = this.sortedCache.tasks
    } else {
      // One shared sorted array per revision: every poll between mutations
      // reuses it instead of re-sorting the whole board (PERF-board-snapshot).
      const sorted = Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt)
      if (!overlayId) {
        this.sortedCache = { rev: this.boardRevision, tasks: sorted }
        tasks = sorted
      } else if (this.versions.hasOverlay(overlayId)) {
        tasks = sorted.map((t) => ({ ...t, version: this.versions.current(t.id, overlayId) }))
      } else {
        tasks = sorted
      }
    }
    return {
      managerId: this.manager,
      tasks,
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
    this.boardRevision += 1
    this.eventsSinceSnapshot += 1
    this.emit('change', this.snapshot())
    // Debounced, not synchronous: a manager claim is an interactive request,
    // and the fsync'd board write does not belong on its critical path.
    this.schedulePersist()
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
    id?: string
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
    const id = (typeof input.id === 'string' && input.id.trim()) ? input.id.trim() : this.nextTaskId()
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
    this.taskLocks.assertCanLock(task, agentId, (id) => this.isManager(id))
    const worker = agentId.trim()
    const filePath = path?.trim()
    if (!filePath) throw new CommandError('invalid', 'path is required')
    const resource = fileResource(filePath)
    const lock = this.taskLocks.acquireExtraFile(taskId, filePath, worker, typeof ttlMs === 'number' ? ttlMs : TASK_LOCK_TTL_MS)
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

    try {
      this.taskLocks.acquireForTask(taskId, task.files, worker, TASK_LOCK_TTL_MS)
    } catch (err) {
      throw err
    }

    task.assignee = worker
    task.state = 'in_progress'
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id, overlayId)
    this.boardRevision += 1
    this.eventsSinceSnapshot += 1
    this.emit('change', this.snapshot(overlayId))
    // Same as claimManager: debounce the disk write off the request path.
    this.schedulePersist()
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
        this.taskLocks.renewForTask(task)
      }
    }
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id, overlayId)
  }

  private releaseTaskLocks(task: Task): void {
    this.taskLocks.releaseForTask(task)
  }

  deleteTask(taskId: string, overlayId?: string): void {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) return
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
