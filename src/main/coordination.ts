import { app } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage'

export const TASK_STATES = ['backlog', 'queued', 'in_progress', 'review', 'done', 'cancelled'] as const
export type TaskState = (typeof TASK_STATES)[number]

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
}

export interface FileLock {
  path: string
  taskId: string
  agentId: string
  expiresAt: number
}

export interface CoordinationSnapshot {
  managerId: string | null
  tasks: Task[]
  locks: FileLock[]
}

export class Forbidden extends Error {
  constructor(
    message: string,
    readonly status = 403,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

const DEFAULT_LOCK_TTL = 15 * 60_000
const MIN_LOCK_TTL = 60_000
const MAX_LOCK_TTL = 60 * 60_000
/** A manager that hasn't acted in this long is presumed gone (process killed,
 *  crashed, etc.) and the role is freed up automatically. */
const MANAGER_TTL = 15 * 60_000

/**
 * Single source of truth for who is coordinating work and what work exists.
 * Exactly one manager agent may hold the role at a time; everything else is
 * either a worker acting on an assigned task, or the human editing the board.
 * Emits `change` whenever state moves so the UI can stay live.
 */
export class CoordinationStore extends EventEmitter {
  private manager: string | null = null
  /** Last time the manager did something as manager; drives {@link MANAGER_TTL}. */
  private managerSeenAt: number | null = null
  private readonly tasks = new Map<string, Task>()
  private readonly locks = new Map<string, FileLock>()
  private counter = 0
  private loaded = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private get file(): string {
    return join(app.getPath('userData'), 'workspace-board.json')
  }

  /**
   * Tasks, the manager role, and file locks all outlive the process now — a
   * board (or a manager claim) that reset itself on every launch was useless
   * for planning. What used to make reviving the manager/locks risky (an
   * agent that no longer exists still "holding" them) is handled instead by
   * {@link pruneStale}: locks already expire on their own TTL, and a manager
   * that stops acting for {@link MANAGER_TTL} is released automatically.
   */
  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = readStoreJson<{ tasks?: unknown; managerId?: unknown; managerSeenAt?: unknown; locks?: unknown }>(
      this.file,
      {}
    )
    if (Array.isArray(raw.tasks))
      for (const entry of raw.tasks) {
        const task = reviveTask(entry)
        if (task) this.tasks.set(task.id, task)
      }
    if (Array.isArray(raw.locks))
      for (const entry of raw.locks) {
        const lock = reviveLock(entry)
        if (lock) this.locks.set(lock.path, lock)
      }
    const seenAt = Number(raw.managerSeenAt) || 0
    if (typeof raw.managerId === 'string' && raw.managerId && Date.now() - seenAt < MANAGER_TTL) {
      this.manager = raw.managerId
      this.managerSeenAt = seenAt
    }
    this.pruneStale()
  }

  /** Live update now, disk write on a short debounce (PERF-005): a burst of
   *  board ops (agent task updates, lock churn) no longer fsyncs per step. */
  private changed(): void {
    this.ensure()
    this.emit('change', this.snapshot())
    this.schedulePersist()
  }

  /** Critical ops (claim): the write must land before the reply returns. */
  private changedNow(): void {
    this.emit('change', this.snapshot())
    this.flush()
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
        tasks: Array.from(this.tasks.values()),
        locks: Array.from(this.locks.values()),
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
   * Clears out everything describing an agent that has gone quiet: expired
   * file locks, and — if none of a task's locks survived that sweep — the
   * task itself falls back to `queued` with its assignee cleared, instead of
   * sitting `in_progress` forever behind a worker that vanished. The manager
   * role gets the same treatment on its own {@link MANAGER_TTL}.
   */
  private pruneStale(): void {
    const now = Date.now()
    const affected = new Set<string>()
    for (const [path, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(path)
        affected.add(lock.taskId)
      }
    }
    let mutated = false
    for (const taskId of affected) {
      const task = this.tasks.get(taskId)
      if (task && task.state === 'in_progress' && !this.hasActiveLock(taskId)) {
        task.state = 'queued'
        task.assignee = undefined
        task.updatedAt = now
        mutated = true
      }
    }
    if (this.manager && this.managerSeenAt !== null && now - this.managerSeenAt > MANAGER_TTL) {
      this.manager = null
      this.managerSeenAt = null
      mutated = true
    }
    // Deferred: calling changed() here would re-enter snapshot() (which calls
    // this method) while still inside it. Breaking out to a microtask lets the
    // current snapshot finish first, so the recursion terminates immediately.
    if (mutated) {
      this.schedulePersist()
      queueMicrotask(() => this.emit('change', this.snapshot()))
    }
  }

  private hasActiveLock(taskId: string): boolean {
    for (const lock of this.locks.values()) if (lock.taskId === taskId) return true
    return false
  }

  snapshot(): CoordinationSnapshot {
    this.ensure()
    this.pruneStale()
    return {
      managerId: this.manager,
      tasks: Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      locks: Array.from(this.locks.values())
    }
  }

  get managerId(): string | null {
    return this.manager
  }

  isManager(agentId: unknown): boolean {
    return typeof agentId === 'string' && agentId.length > 0 && agentId === this.manager
  }

  claimManager(agentId: string): { managerId: string; role: 'manager' } {
    const id = agentId?.trim()
    if (!id) throw new Forbidden('agentId is required', 400)
    if (this.manager && this.manager !== id) {
      throw new Forbidden('manager already assigned', 409, { managerId: this.manager })
    }
    this.manager = id
    this.managerSeenAt = Date.now()
    this.changedNow()
    return { managerId: id, role: 'manager' }
  }

  releaseManager(agentId: string): void {
    if (!this.manager || agentId !== this.manager) {
      throw new Forbidden('only the current manager may release this role')
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
    if (!title) throw new Forbidden('title is required', 400)
    this.touchManager(input.createdBy)
    const now = Date.now()
    const task: Task = {
      id: this.nextTaskId(),
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
      updatedAt: now
    }
    this.tasks.set(task.id, task)
    this.changed()
    return task
  }

  /**
   * Claiming auto-locks every file the task declared, atomically: a second
   * task whose file list overlaps one still in progress is rejected right
   * here, instead of leaving the collision to be discovered only if (and
   * when) a worker remembers to call `lock_task_file` itself. This is what
   * actually makes `files` a reservation rather than a comment.
   */
  claimTask(taskId: string, agentId: string): Task {
    this.ensure()
    this.pruneStale()
    const task = this.tasks.get(taskId)
    if (!task) throw new Forbidden('task not found', 404)
    const worker = agentId?.trim()
    if (!worker || worker === this.manager) throw new Forbidden('a worker agentId is required')
    // Backlog counts as claimable: the board renders backlog and queued in one
    // "To Do" column, so a card the user dragged there must stay pickable.
    if (task.state !== 'queued' && task.state !== 'backlog')
      throw new Forbidden('task is not available', 409, { task })

    const conflicts = task.files
      .map((path) => this.locks.get(path))
      .filter((lock): lock is FileLock => !!lock && lock.taskId !== taskId)
    if (conflicts.length > 0) {
      throw new Forbidden('files are locked by another in-progress task', 409, { locks: conflicts })
    }

    const now = Date.now()
    for (const path of task.files) {
      this.locks.set(path, { path, taskId, agentId: worker, expiresAt: now + DEFAULT_LOCK_TTL })
    }
    task.assignee = worker
    task.state = 'in_progress'
    task.updatedAt = now
    this.changedNow()
    return task
  }

  updateTask(taskId: string, agentId: string, state: unknown): Task {
    this.ensure()
    const task = this.tasks.get(taskId)
    if (!task) throw new Forbidden('task not found', 404)
    if (!this.isManager(agentId) && agentId !== task.assignee) {
      throw new Forbidden('only the manager or assigned worker may update this task')
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
    if (!task) throw new Forbidden('task not found', 404)
    const owns = task.assignee === actor.name || task.createdBy === USER_AUTHOR
    if (actor.role !== 'lead' && !owns) throw new Forbidden('only the lead may edit other peopleвЂ™s tasks')
    if (actor.role !== 'lead' && patch.assignee !== undefined)
      throw new Forbidden('only the lead may reassign tasks')

    if (patch.state !== undefined) this.applyState(task, patch.state)
    if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim()
    if (typeof patch.brief === 'string') task.brief = patch.brief
    if (patch.tags !== undefined) task.tags = normalizeTags(patch.tags)
    if (patch.dueAt !== undefined) task.dueAt = patch.dueAt === null ? undefined : normalizeDue(patch.dueAt)
    if (patch.assignee !== undefined)
      task.assignee = typeof patch.assignee === 'string' && patch.assignee.trim() ? patch.assignee.trim() : undefined
    task.updatedAt = Date.now()
    this.changed()
    return task
  }

  private applyState(task: Task, state: unknown): void {
    if (typeof state === 'string' && (TASK_STATES as readonly string[]).includes(state)) {
      task.state = state as TaskState
      if (state === 'queued') {
        task.assignee = undefined
        this.releaseTaskLocks(task.id)
      } else if (state === 'done' || state === 'cancelled') {
        // Free the files the moment the task leaves the board instead of
        // waiting out the TTL — the next task queued behind this one (a very
        // common shape for a hub file) doesn't have to sit idle for nothing.
        this.releaseTaskLocks(task.id)
      } else {
        // Any state transition is a liveness signal from whoever is driving
        // the task, so it resets the clock instead of the file going stale
        // out from under a worker still mid-edit (a long in_progress task
        // otherwise loses its lock to TTL even while being actively worked).
        this.renewTaskLocks(task.id)
      }
    }
    task.updatedAt = Date.now()
  }

  private renewTaskLocks(taskId: string): void {
    const expiresAt = Date.now() + DEFAULT_LOCK_TTL
    for (const lock of this.locks.values()) {
      if (lock.taskId === taskId) lock.expiresAt = expiresAt
    }
  }

  private releaseTaskLocks(taskId: string): void {
    for (const [path, lock] of this.locks) {
      if (lock.taskId === taskId) this.locks.delete(path)
    }
  }

  deleteTask(taskId: string): void {
    this.ensure()
    if (!this.tasks.delete(taskId)) throw new Forbidden('task not found', 404)
    this.releaseTaskLocks(taskId)
    this.changed()
  }

  lockFile(input: { path: string; taskId: string; agentId: string; ttlMs?: unknown }): FileLock {
    this.ensure()
    this.pruneStale()
    const path = input.path?.trim()
    const task = this.tasks.get(input.taskId)
    if (!path || !task || task.assignee !== input.agentId) {
      throw new Forbidden('lock requires an assigned task and its worker')
    }
    const existing = this.locks.get(path)
    if (existing && (existing.taskId !== input.taskId || existing.agentId !== input.agentId)) {
      throw new Forbidden('file is locked', 409, { lock: existing })
    }
    const lock: FileLock = {
      path,
      taskId: input.taskId,
      agentId: input.agentId,
      expiresAt: Date.now() + clamp(Number(input.ttlMs) || DEFAULT_LOCK_TTL, MIN_LOCK_TTL, MAX_LOCK_TTL)
    }
    this.locks.set(path, lock)
    this.changed()
    return lock
  }

  unlockFile(path: string, agentId: string): void {
    const lock = this.locks.get(path)
    if (!lock) throw new Forbidden('lock not found', 404)
    if (agentId !== lock.agentId && !this.isManager(agentId)) throw new Forbidden('not lock owner')
    this.locks.delete(path)
    this.changed()
  }

  /** Operator escape hatch: clears every lock regardless of owner. */
  forceReleaseLocks(): void {
    this.locks.clear()
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
    updatedAt: Number(raw.updatedAt) || now
  }
}

/**
 * Rebuilds one file lock from the persisted board. Malformed entries are
 * dropped rather than trusted; already-expired ones are kept so
 * {@link CoordinationStore.pruneStale} can requeue their task the same way it
 * would if the expiry had happened live.
 */
function reviveLock(entry: unknown): FileLock | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const path = typeof raw.path === 'string' ? raw.path : ''
  const taskId = typeof raw.taskId === 'string' ? raw.taskId : ''
  const agentId = typeof raw.agentId === 'string' ? raw.agentId : ''
  if (!path || !taskId || !agentId) return null
  return { path, taskId, agentId, expiresAt: Number(raw.expiresAt) || 0 }
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
