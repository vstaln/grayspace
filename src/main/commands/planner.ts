import type { PlanItem } from '../plannerStore.ts'
import { CommandError, parseResource } from '../core/index.ts'
import type { CommandDeps } from './index.ts'

function planIdOf(target: string): string {
  const parsed = parseResource(target)
  if (!parsed || parsed.scheme !== 'plan') throw new CommandError('invalid', `${target} is not a plan item`)
  return parsed.id
}

interface PlanCreatePayload {
  title?: string
  note?: string
  day?: string
  time?: string
}

interface PlanUpdatePayload {
  title?: string
  note?: string
  day?: string | null
  time?: string | null
  done?: boolean
  order?: number
}

/**
 * The planner's outline: a flat list any actor may add lines to and check off,
 * addressed one item at a time so two writers editing different lines never
 * collide on the same lock the way a single "the whole list" resource would.
 */
export function registerPlannerCommands({ core, planner }: CommandDeps): void {
  const { bus } = core

  bus.registerVersions('plan', planner.versions)

  bus.register<PlanCreatePayload, PlanItem>('plan.create', {
    ignoreVersion: true,
    apply: ({ command, actor }) => {
      const p = command.payload ?? {}
      return planner.createItem({ ...p, createdBy: actor.id })
    }
  })

  bus.register<PlanUpdatePayload, PlanItem>('plan.update', {
    apply: ({ command }) => planner.updateItem(planIdOf(command.target), command.payload ?? {})
  })

  bus.register<Record<string, never>, { id: string }>('plan.delete', {
    apply: ({ command }) => {
      const id = planIdOf(command.target)
      planner.deleteItem(id)
      return { id }
    }
  })
}
