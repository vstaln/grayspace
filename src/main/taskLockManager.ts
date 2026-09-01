import { CommandError, fileResource, type LockManager, type ResourceLock } from './core/index.ts'
import type { Task } from './coordination.ts'

export const TASK_LOCK_TTL_MS = 10 * 60_000

/**
 * Isolated file-lock lifecycle for board tasks.
 * CoordinationStore delegates all lock acquire/renew/release here so the
 * business rules (rollback, holder check, TTL) are testable in one place
 * instead of spread across claim/update/prune.
 */
export class TaskLockManager {
  private readonly locks: LockManager
  constructor(locks: LockManager) { this.locks = locks }

  acquireForTask(taskId: string, files: string[], actorId: string, ttlMs: number = TASK_LOCK_TTL_MS): void {
    const taken: string[] = []
    try {
      for (const path of files) {
        const resource = fileResource(path)
        this.locks.acquire({ resource, actorId, ttlMs, reason: `task ${taskId}` })
        taken.push(resource)
      }
    } catch (err) {
      for (const resource of taken) {
        try {
          this.locks.release(resource, actorId)
        } catch {
          /* TTL will reclaim */
        }
      }
      throw err
    }
  }

  acquireExtraFile(taskId: string, path: string, actorId: string, ttlMs: number = TASK_LOCK_TTL_MS): ResourceLock {
    const resource = fileResource(path)
    return this.locks.acquire({ resource, actorId, ttlMs, reason: `task ${taskId}` })
  }

  renewForTask(task: Task): void {
    if (!task.assignee) return
    for (const path of task.files) {
      const resource = fileResource(path)
      if (this.locks.isHeldBy(resource, task.assignee)) {
        this.locks.renew(resource, task.assignee, TASK_LOCK_TTL_MS)
      }
    }
  }

  releaseForTask(task: Task): void {
    const owner = task.assignee
    for (const path of task.files) {
      const resource = fileResource(path)
      const holder = this.locks.holder(resource)
      if (holder && holder.reason === `task ${task.id}` && (!owner || holder.actorId === owner)) {
        this.locks.release(resource, holder.actorId)
      }
    }
  }

  isTaskLocksHeld(task: Task, actorId: string): boolean {
    if (task.files.length === 0) return false
    return task.files.some((path) => this.locks.isHeldBy(fileResource(path), actorId))
  }

  assertCanLock(task: Task, actorId: string, isManager: (id: string) => boolean): void {
    const worker = actorId?.trim()
    if (!worker) throw new CommandError('invalid', 'agentId is required')
    if (!isManager(worker) && worker !== task.assignee) {
      throw new CommandError('forbidden', 'only the manager or assigned worker may lock extra files')
    }
    if (task.state !== 'in_progress') {
      throw new CommandError('conflict', 'task is not in progress', { task })
    }
  }
}
