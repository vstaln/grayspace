import { streamOpenRouter } from '../openrouter.ts'
import type { PlanStep, RunState } from './types.ts'

/**
 * Commands the assistant is allowed to plan. Deliberately a subset: the model
 * proposes work, it does not get to reach for anything the bus can do. Two
 * of them are destructive and always stop at the human gate.
 */
export const PLANNABLE = {
  'note.create': { approval: false },
  'note.update': { approval: false },
  'note.delete': { approval: true },
  'widget.create': { approval: false },
  'widget.update': { approval: false },
  'widget.remove': { approval: true },
  'terminal.create': { approval: false },
  'terminal.write': { approval: true },
  'task.create': { approval: false },
  'task.update': { approval: false }
} as const

const SYSTEM = `You plan work inside OrcSpace, an infinite canvas with terminals, notes and a kanban board.
Answer with JSON only: {"steps":[{"command":"…","target":"scheme:id","payload":{…},"summary":"…"}]}
- command must be one of: ${Object.keys(PLANNABLE).join(', ')}
- target is "scheme:id"; use "note:new", "task:new", "widget:new" or "terminal:new" when creating
- summary is one short sentence in the user's language
- keep the plan to at most 6 steps, and prefer the smallest plan that achieves the goal
- if the goal needs no state change, answer {"steps":[]}`

export interface PlannerDeps {
  apiKey(): string | undefined
  model(): string | undefined
  /** Facts about the workspace worth putting in front of the planner. */
  context(): string
}

/**
 * Turns a goal into commands via OpenRouter.
 *
 * The model never touches state: it emits a plan, every step of which is then
 * validated against {@link PLANNABLE} and submitted through the bus like any
 * other actor's write. A hallucinated command type is dropped here rather than
 * being discovered as an `unknown_command` three layers down.
 */
export function createPlanner(deps: PlannerDeps): (state: RunState) => Promise<PlanStep[]> {
  return async (state: RunState): Promise<PlanStep[]> => {
    const apiKey = deps.apiKey()
    const model = deps.model()
    if (!apiKey) throw new Error('OpenRouter key missing — add it in the chat settings before running the assistant')
    if (!model) throw new Error('no OpenRouter model selected')

    const prompt = `${SYSTEM}\n\nWorkspace context:\n${deps.context()}\n\nGoal:\n${state.goal}`
    const text = await complete(apiKey, model, prompt)
    return parsePlan(text)
  }
}

/** Collects a streamed completion into one string. */
function complete(apiKey: string, model: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    void streamOpenRouter(
      apiKey,
      model,
      prompt,
      {
        onDelta: (text) => (out += text),
        onDone: () => {
          clearTimeout(timer)
          resolve(out)
        },
        onError: (message) => {
          clearTimeout(timer)
          reject(new Error(message))
        }
      },
      controller.signal
    )
  })
}

/**
 * Pulls the plan out of a model reply and drops anything unrecognised.
 *
 * Models fence their JSON, prepend a sentence, or emit a bare array roughly as
 * often as they follow the format exactly, so the parser tolerates all three
 * rather than failing the run over presentation.
 */
export function parsePlan(text: string): PlanStep[] {
  const json = extractJson(text)
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const rawSteps = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { steps?: unknown }).steps)
      ? (parsed as { steps: unknown[] }).steps
      : []

  const steps: PlanStep[] = []
  for (const raw of rawSteps.slice(0, 6)) {
    const entry = raw as Record<string, unknown>
    const command = String(entry.command ?? '')
    const rule = (PLANNABLE as Record<string, { approval: boolean } | undefined>)[command]
    if (!rule) continue
    const target = String(entry.target ?? '')
    if (!/^[a-z]+:.+/.test(target)) continue
    steps.push({
      command,
      target,
      payload: (entry.payload as unknown) ?? {},
      summary: String(entry.summary ?? command),
      needsApproval: rule.approval
    })
  }
  return steps
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start < 0) return null
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  return end > start ? body.slice(start, end + 1) : null
}
