import type { PlanItem } from '../plannerStore.ts'
import { CommandError, parseResource, type CommandPayloadSchema } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function planIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'plan') throw new CommandError('invalid', `${target} is not a plan item`)
  return parsed.id
}

interface PlanCreatePayload {
  title?: string
  note?: string
  project?: string
  day?: string
  time?: string
  attachments?: string[]
}

interface PlanUpdatePayload {
  title?: string
  note?: string
  project?: string | null
  day?: string | null
  time?: string | null
  done?: boolean
  order?: number
  attachments?: string[] | null
}

const PLAN_FIELDS: CommandPayloadSchema['properties'] = {
  title: { type: 'string', description: 'Checklist line text' },
  note: { type: 'string', description: 'Longer note under the line' },
  project: { type: 'string', description: 'Optional group label (e.g. a release)' },
  day: { type: 'string', description: 'Day YYYY-MM-DD; omit for the undated inbox' },
  time: { type: 'string', description: 'Time HH:MM' },
  attachments: { type: 'array', description: 'Attached photo paths (from media store)' }
}

export function registerPlannerCommands({ core, planner }: CommandDeps): void {
  const { flow } = core

  flow.registerVersions('plan', planner.versions)

  flow.registerDefinition<PlanCreatePayload, PlanItem>({
    type: 'plan.create',
    description: 'Add a line to the day planner.',
    targetScheme: 'plan',
    ignoreVersion: true,
    payloadSchema: { type: 'object', properties: PLAN_FIELDS },
    handler: {
      apply: ({ command, actor }) => {
        const p = command.payload ?? {}
        return planner.createItem({ ...p, createdBy: actor.id })
      }
    }
  })

  flow.registerDefinition<PlanUpdatePayload, PlanItem>({
    type: 'plan.update',
    description:
      'Update a planner line (text, day/time, done, order, attachments). Pass null for day/project/time/attachments to clear them.',
    targetScheme: 'plan',
    payloadSchema: {
      type: 'object',
      properties: { ...PLAN_FIELDS, done: { type: 'boolean' }, order: { type: 'number' } }
    },
    handler: {
      apply: ({ command }) => planner.updateItem(planIdOf(command.target), command.payload ?? {})
    }
  })

  /** Dedicated check/uncheck — same store field as plan.update done, clearer for agents. */
  flow.registerDefinition<{ done?: boolean }, PlanItem>({
    type: 'plan.toggle',
    description: 'Check or uncheck a planner line. Omit `done` to flip the current value.',
    targetScheme: 'plan',
    payloadSchema: {
      type: 'object',
      properties: { done: { type: 'boolean', description: 'true = check as done, false = reopen' } }
    },
    handler: {
      apply: ({ command }) => {
        const done = command.payload?.done
        return planner.toggleItem(planIdOf(command.target), typeof done === 'boolean' ? done : undefined)
      }
    }
  })

  flow.registerDefinition<Record<string, never>, { id: string }>({
    type: 'plan.delete',
    description: 'Delete a planner line.',
    targetScheme: 'plan',
    payloadSchema: { type: 'object', properties: {} },
    handler: {
      apply: ({ command }) => {
        const id = planIdOf(command.target)
        planner.deleteItem(id)
        return { id }
      }
    }
  })
}
