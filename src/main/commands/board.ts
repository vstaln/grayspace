import { USER_AUTHOR, type Task, type TaskState } from '../coordination.ts'
import { CommandError, parseResource, type CommandPayloadSchema } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function taskIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'task') throw new CommandError('invalid', `${target} is not a task`)
  return parsed.id
}

const TASK_STATES = ['backlog', 'queued', 'in_progress', 'review', 'done', 'cancelled'] as const

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
  role?: 'member' | 'lead'
  userName?: string
}

const TASK_CREATE_SCHEMA: CommandPayloadSchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', description: 'Card title' },
    brief: { type: 'string', description: 'What to do, context, acceptance criteria' },
    files: { type: 'array', items: { type: 'string' }, description: 'Files the task touches (auto-locked on claim)' },
    state: { type: 'string', enum: TASK_STATES, description: 'Initial column (default queued)' },
    tags: { type: 'array', items: { type: 'string' } },
    dueAt: { type: 'number', description: 'Unix ms deadline' },
    assignee: { type: 'string', description: 'Agent id to reserve files for' },
    maxSteps: { type: 'number' },
    maxReviewIterations: { type: 'number' }
  }
}

const TASK_UPDATE_SCHEMA: CommandPayloadSchema = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: TASK_STATES },
    title: { type: 'string' },
    brief: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    dueAt: { type: 'number', description: 'Unix ms; null clears' },
    assignee: { type: 'string', description: 'null unassigns' },
    role: { type: 'string', enum: ['member', 'lead'], description: 'Board role of the human editing; agents never set this' },
    userName: { type: 'string' }
  }
}

export function registerBoardCommands({ core, board }: CommandDeps): void {
  const { bus } = core

  bus.registerVersions('task', board.versions)

  bus.registerDefinition<TaskCreatePayload, Task>({
    type: 'task.create',
    description: 'Create a kanban task. Only the manager may create work for others.',
    targetScheme: 'task',
    ignoreVersion: true,
    payloadSchema: TASK_CREATE_SCHEMA,
    handler: {
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
    }
  })

  /**
   * One update command for both writers, dispatching on actor type rather than
   * on transport: the human's edits carry board-role rules (a member may only
   * touch their own cards), an agent's carry manager/assignee rules. Before the
   * bus these were two functions reachable from two different places.
   */
  bus.registerDefinition<TaskUpdatePayload, Task>({
    type: 'task.update',
    description: 'Update a task. Humans edit via board-role rules, agents via manager/assignee rules.',
    targetScheme: 'task',
    payloadSchema: TASK_UPDATE_SCHEMA,
    handler: {
      apply: ({ command, actor }) => {
        const id = taskIdOf(command.target)
        const p = command.payload ?? {}
        if (actor.type === 'user') {
          // Default to the least-privileged board role. The IPC path always injects
          // the real settings role; never elevate a missing field to lead.
          return board.updateTaskAsUser(id, p, { role: p.role ?? 'member', name: p.userName || USER_AUTHOR })
        }
        return board.updateTask(id, actor.id, p.state)
      }
    }
  })

  bus.registerDefinition<Record<string, never>, Task>({
    type: 'task.claim',
    description: 'Claim a task and take its file locks.',
    targetScheme: 'task',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command, actor }) => board.claimTask(taskIdOf(command.target), actor.id)
    }
  })

  bus.registerDefinition<Record<string, never>, { id: string }>({
    type: 'task.delete',
    description: 'Delete a task (manager only).',
    targetScheme: 'task',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command, actor }) => {
        const id = taskIdOf(command.target)
        if (actor.type === 'agent' && !board.isManager(actor.id)) {
          throw new CommandError('forbidden', 'only the manager may delete tasks')
        }
        board.deleteTask(id)
        return { id }
      }
    }
  })

  // ---- the manager role ---------------------------------------------------
  // Addressed as `task:manager`: it is board state, exactly one actor may hold
  // it, and routing it through the bus means the claim is serialised with
  // everything else rather than racing task writes.

  bus.registerDefinition<Record<string, never>, { managerId: string; role: 'manager' }>({
    type: 'manager.claim',
    description: 'Become the single board manager.',
    targetScheme: 'task',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ actor }) => board.claimManager(actor.id)
    }
  })

  bus.registerDefinition<{ force?: boolean }, { managerId: null }>({
    type: 'manager.release',
    description: 'Release the manager role. `force` (user only) resets a dead manager.',
    targetScheme: 'task',
    ignoreVersion: true,
    payloadSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Operator escape hatch: reset even if someone else holds the role' } }
    },
    handler: {
      apply: ({ command, actor }) => {
        // The force path is the operator escape hatch in the UI: the manager may
        // be an agent whose process is long gone and cannot release itself.
        if (command.payload?.force && actor.type === 'user') board.forceResetManager()
        else board.releaseManager(actor.id)
        return { managerId: null }
      }
    }
  })
}

/** Sentinel targets for board commands that do not address one card. */
export const TASK_MANAGER_TARGET = 'task:manager'
