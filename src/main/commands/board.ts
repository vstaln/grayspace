import { USER_AUTHOR, type Task, type TaskState } from '../coordination'
import { CommandError, parseResource } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function taskIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'task') throw new CommandError('invalid', `${target} is not a task`)
  return parsed.id
}

interface TaskCreatePayload {
  title?: string
  brief?: string
  files?: string[]
  state?: TaskState
  tags?: string[]
  dueAt?: number
  assignee?: string
  maxSteps?: number
  maxReviewIterations?: number
}

interface TaskUpdatePayload {
  state?: TaskState
  title?: string
  brief?: string
  tags?: string[]
  dueAt?: number | null
  assignee?: string | null
  /** Board role of the human editing; agents never set this. */
  role?: 'member' | 'lead'
  userName?: string
}

export function registerBoardCommands({ core, board }: CommandDeps): void {
  const { bus } = core

  bus.registerVersions('task', board.versions)

  bus.register<TaskCreatePayload, Task>('task.create', {
    ignoreVersion: true,
    apply: ({ command, actor }) => {
      const p = command.payload ?? {}
      // Only the manager may create work for others; the human always may.
      if (actor.type === 'agent' && board.managerId && !board.isManager(actor.id)) {
        throw new CommandError('forbidden', 'only the manager may create tasks', { managerId: board.managerId })
      }
      return board.createTask({
        ...p,
        title: String(p.title ?? ''),
        createdBy: actor.type === 'user' ? USER_AUTHOR : actor.id
      })
    }
  })

  /**
   * One update command for both writers, dispatching on actor type rather than
   * on transport: the human's edits carry board-role rules (a member may only
   * touch their own cards), an agent's carry manager/assignee rules. Before the
   * bus these were two functions reachable from two different places.
   */
  bus.register<TaskUpdatePayload, Task>('task.update', {
    apply: ({ command, actor }) => {
      const id = taskIdOf(command.target)
      const p = command.payload ?? {}
      if (actor.type === 'user') {
        return board.updateTaskAsUser(id, p, { role: p.role ?? 'lead', name: p.userName || USER_AUTHOR })
      }
      return board.updateTask(id, actor.id, p.state)
    }
  })

  bus.register<Record<string, never>, Task>('task.claim', {
    apply: ({ command, actor }) => board.claimTask(taskIdOf(command.target), actor.id)
  })

  bus.register<Record<string, never>, { id: string }>('task.delete', {
    apply: ({ command, actor }) => {
      const id = taskIdOf(command.target)
      if (actor.type === 'agent' && !board.isManager(actor.id)) {
        throw new CommandError('forbidden', 'only the manager may delete tasks')
      }
      board.deleteTask(id)
      return { id }
    }
  })

  // ---- the manager role ---------------------------------------------------
  // Addressed as `task:manager`: it is board state, exactly one actor may hold
  // it, and routing it through the bus means the claim is serialised with
  // everything else rather than racing task writes.

  bus.register<Record<string, never>, { managerId: string; role: 'manager' }>('manager.claim', {
    ignoreVersion: true,
    apply: ({ actor }) => board.claimManager(actor.id)
  })

  bus.register<{ force?: boolean }, { managerId: null }>('manager.release', {
    ignoreVersion: true,
    apply: ({ command, actor }) => {
      // The force path is the operator escape hatch in the UI: the manager may
      // be an agent whose process is long gone and cannot release itself.
      if (command.payload?.force && actor.type === 'user') board.forceResetManager()
      else board.releaseManager(actor.id)
      return { managerId: null }
    }
  })
}

/** Sentinel targets for board commands that do not address one card. */
export const TASK_MANAGER_TARGET = 'task:manager'
