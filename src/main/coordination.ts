import { app } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage'
import { CommandError, fileResource, VersionRegistry, type LockManager, type ResourceLock } from './core/index.ts'

export const TASK_STATES = ['backlog', 'queued', 'in_progress', 'review', 'done', 'cancelled'] as const
export type TaskState = (typeof TASK_STATES)[number]

/** Bumped whenever the persisted board shape changes. */
export const BOARD_SCHEMA_VERSION = 2

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

export interface CoordinationSnapshot {
  managerId: string | null
  tasks: Task[]
  /**
   * Live resource locks, read straight from the core lock manager. The board
   * no longer keeps a lock table of its own: a card is a unit of work, not a
   * thing that can be held, and pretending otherwise is what let two agents
   * with different cards edit the same file.
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
 * Mutating methods here are called only from the command handlers in
 * `commands/board.ts`. File reservations are delegated to the core
 * {@link LockManager} — this class decides *which* resources a claimed task
 * needs, and the lock manager decides whether they are available.
 */
export class CoordinationStore extends EventEmitter {
  private manager: string | null = null
  /** Last time the manager did something as manager; drives {@link MANAGER_TTL}. */
  private managerSeenAt: number | null = null
  private readonly tasks = new Map<string, Task>()
  private readonly locks: LockManager
  private counter = 0
  private loaded = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  readonly versions = new VersionRegistry('task')

  constructor(locks: LockManager) {
    super()
    this.locks = locks
  }

  private get file(): string {
    return join(app.getPath('userData'), 'workspace-board.json')
  }

  /**
   * Tasks and the manager claim outlive the process; locks deliberately do
   * not. Anything that was holding a file when the app died is gone, so the
   * board comes back with every resource free and `in_progress` cards whose
   * worker never returns fall back to `queued` on the first prune.
   */
  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : []
    for (const entry of tasks) {
      const task = reviveTask(entry)
      if (task) this.tasks.set(task.id, task)
    }
    this.versions.seed(this.tasks.values())
    const seenAt = Number(raw.managerSeenAt) || 0
    if (typeof raw.managerId === 'string' && raw.managerId && Date.now() - seenAt < MANAGER_TTL) {
      this.manager = raw.managerId
      this.managerSeenAt = seenAt
    }
    // Every task that was in flight when the process died has lost its locks
    // along with the worker holding them.
    for (const task of this.tasks.values()) {
      if (task.state !== 'in_progress') continue
      task.state = 'queued'
      task.assignee = undefined
    }
    this.pruneStale()
  }

  /** Live update now, disk write on a short debounce. */
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
  }

  private flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      writeJsonAtomic(this.file, {
        schemaVersion: BOARD_SCHEMA_VERSION,
        tasks: Array.from(this.tasks.values()),
        managerId: this.manager,
        managerSeenAt: this.managerSeenAt
      })
    } catch (err) {
      console.error('failed to persist task board', err)
    }
  }

  /** Marks the manager as alive; called on every action it takes as manager. */
  private touchManager(agentId: string): void {
    if (agentId === this.manager) this.managerSeenAt = Date.now()
  }

  /** Flushes any pending write; call from the app's shutdown path. */
  dispose(): void {
    this.flush()
  }

  private nextTaskId(): string {
    this.counter += 1
    return `task-${Date.now()}-${this.counter}`
  }

  /**
   * Requeues tasks whose worker has lost the files it was holding (the locks
   * expired with the agent), and frees a manager that has gone quiet.
   */
  private pruneStale(): void {
    const now = Date.now()
    let mutated = false
    for (const task of this.tasks.values()) {
      if (task.state !== 'in_progress' || !task.assignee) continue
      if (task.files.length === 0) continue
      const stillHeld = task.files.some((path) => this.locks.isHeldBy(fileResource(path), task.assignee as string))
      if (stillHeld) continue
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
    // Deferred: calling changed() here would re-enter snapshot() (which calls
    // this method) while still inside it.
    if (mutated) {
      this.schedulePersist()
      queueMicrotask(() => this.emit('change', this.snapshot()))
    }
  }

  snapshot(): CoordinationSnapshot {
    this.ensure()
    this.pruneStale()
    return {
      managerId: this.manager,
      tasks: Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      locks: this.locks.list()
    }
  }

  task(id: string): Task | undefined {
    this.ensure()
    return this.tasks.get(id)
  }

  get managerId(): string | null {
    return this.manager
  }

  isManager(agentId: unknown): boolean {
    return typeof agentId === 'string' && agentId.length > 0 && agentId === this.manager
  }

  claimManager(agentId: string): { managerId: string; role: 'manager' } {
    this.ensure()
    const id = agentId?.trim()
    if (!id) throw new CommandError('invalid', 'agentId is required')
    if (this.manager && this.manager !== id) {
      throw new CommandError('forbidden', 'manager already assigned', { managerId: this.manager })
    }
    this.manager = id
    this.managerSeenAt = Date.now()
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
    this.changed()
  }

  /** Operator escape hatch from the UI: drops the role no matter who holds it. */
  forceResetManager(): void {
    this.manager = null
    this.managerSeenAt = null
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
  }): Task {
    this.ensure()
    const title = input.title?.trim()
    if (!title) throw new CommandError('invalid', 'title is required')
    this.touchManager(input.createdBy)
    const now = Date.now()
    const id = this.nextTaskId()
    const task: Task = {
      id,
      title,
      brief: typeof input.brief === 'string' ? input.brief : '',
      files: Array.isArray(input.files) ? input.files.filter((p): p is string => typeof p === 'string') : [],
      state: input.state && TASK_STATES.includes(input.state) ? input.state : 'queued',
      createdBy: input.createdBy,
      assignee: typeof input.assignee === 'string' && input.assignee.trim() ? input.assignee.trim() : undefined,
      tags: normalizeTags(input.tags),
      dueAt: normalizeDue(input.dueAt),
      maxSteps: clamp(Number(input.maxSteps) || 20, 1, 100),
      maxReviewIterations: clamp(Number(input.maxReviewIterations) || 2, 1, 10),
      createdAt: now,
      updatedAt: now,
      version: this.versions.bump(id)
    }
    this.tasks.set(task.id, task)
    this.changed()
    return task
  }

  /**
   * Claiming reserves every file the task declared, through the real lock
   * manager, atomically: if any of them is held by another actor the whole
   * claim is rolled back. This is what makes `files` a reservation rather than
   * a comment — and unlike the old per-task table, the reservation is on the
   * same resources an agent's terminal commands are checked against.
   */
  claimTask(taskId: string, agentId: string): Task {
    this.ensure()
    this.pruneStale()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    const worker = agentId?.trim()
    if (!worker || worker === this.manager) throw new CommandError('invalid', 'a worker agentId is required')
    // Backlog counts as claimable: the board renders backlog and queued in one
    // "To Do" column, so a card the user dragged there must stay pickable.
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
      for (const resource of taken) this.locks.release(resource, worker)
      throw err
    }

    task.assignee = worker
    task.state = 'in_progress'
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id)
    this.emit('change', this.snapshot())
    this.flush()
    return task
  }

  updateTask(taskId: string, agentId: string, state: unknown): Task {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    if (!this.isManager(agentId) && agentId !== task.assignee) {
      throw new CommandError('forbidden', 'only the manager or assigned worker may update this task')
    }
    this.touchManager(agentId)
    this.applyState(task, state)
    this.changed()
    return task
  }

  /**
   * Board edits from the human. A `lead` may edit any card; a `member` may only
   * touch cards they own — the same rule the UI renders, enforced here too.
   */
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
    actor: { role: 'member' | 'lead'; name: string } = { role: 'lead', name: USER_AUTHOR }
  ): Task {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    const owns = task.assignee === actor.name || task.createdBy === USER_AUTHOR
    if (actor.role !== 'lead' && !owns) throw new CommandError('forbidden', 'only the lead may edit other people’s tasks')
    if (actor.role !== 'lead' && patch.assignee !== undefined)
      throw new CommandError('forbidden', 'only the lead may reassign tasks')

    if (patch.state !== undefined) this.applyState(task, patch.state)
    if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim()
    if (typeof patch.brief === 'string') task.brief = patch.brief
    if (patch.tags !== undefined) task.tags = normalizeTags(patch.tags)
    if (patch.dueAt !== undefined) task.dueAt = patch.dueAt === null ? undefined : normalizeDue(patch.dueAt)
    if (patch.assignee !== undefined)
      task.assignee = typeof patch.assignee === 'string' && patch.assignee.trim() ? patch.assignee.trim() : undefined
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id)
    this.changed()
    return task
  }

  private applyState(task: Task, state: unknown): void {
    if (typeof state === 'string' && (TASK_STATES as readonly string[]).includes(state)) {
      task.state = state as TaskState
      if (state === 'queued' || state === 'done' || state === 'cancelled') {
        // Free the files the moment the card stops being worked on instead of
        // waiting out the TTL — the next task queued behind this one (a very
        // common shape for a hub file) doesn't have to sit idle for nothing.
        if (state === 'queued') task.assignee = undefined
        this.releaseTaskLocks(task)
      } else if (task.assignee) {
        // Any state transition is a liveness signal from whoever is driving the
        // task, so it resets the clock instead of the files going stale out
        // from under a worker still mid-edit.
        for (const path of task.files) {
          const resource = fileResource(path)
          if (this.locks.isHeldBy(resource, task.assignee)) this.locks.renew(resource, task.assignee, TASK_LOCK_TTL_MS)
        }
      }
    }
    task.updatedAt = Date.now()
    task.version = this.versions.bump(task.id)
  }

  private releaseTaskLocks(task: Task): void {
    const owner = task.assignee
    for (const path of task.files) {
      const resource = fileResource(path)
      const holder = this.locks.holder(resource)
      // Only locks this task actually took are dropped: a file another actor
      // has picked up since must not be yanked out from under it.
      if (holder && holder.reason === `task ${task.id}` && (!owner || holder.actorId === owner)) {
        this.locks.release(resource, holder.actorId)
      }
    }
  }

  deleteTask(taskId: string): void {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) throw new CommandError('not_found', 'task not found')
    this.releaseTaskLocks(task)
    this.tasks.delete(taskId)
    this.versions.forget(taskId)
    this.changed()
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Rebuilds one task from the persisted board, discarding anything malformed.
 * The file is plain JSON in the user's profile, so it has to be treated as
 * untrusted input rather than assumed to match the current shape.
 */
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
    // The assignee is kept even though that agent's process is gone: the name is
    // the record of who last had the card, and the board lets the user move it.
    assignee: typeof raw.assignee === 'string' && raw.assignee.trim() ? raw.assignee.trim() : undefined,
    tags: normalizeTags(raw.tags),
    dueAt: normalizeDue(raw.dueAt),
    maxSteps: clamp(Number(raw.maxSteps) || 20, 1, 100),
    maxReviewIterations: clamp(Number(raw.maxReviewIterations) || 2, 1, 10),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    // A board written before versions existed starts at 1 rather than 0, so a
    // client that reads it can send a matching baseVersion immediately.
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

/** Accepts an epoch ms number or a `YYYY-MM-DD` string from the date input. */
function normalizeDue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const at = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(at) ? at : undefined
}
