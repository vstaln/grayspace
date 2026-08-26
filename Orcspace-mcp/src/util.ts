import { z } from 'zod'
import { text } from './control.js'

/**
 * Shared plumbing for the ten consolidated tools. Each tool takes an `action`
 * enum and routes to the control API; these helpers keep every handler short
 * and make bad calls answer with instructions instead of stack traces.
 */

export const AgentId = z
  .string()
  .min(1)
  .describe('Your stable agent id — pick ONE at session start and reuse it in every write')

/** Thrown for missing/unknown inputs; surfaced to the model as a readable hint. */
export class ToolInputError extends Error {}

export function req<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null || value === '') throw new ToolInputError(message)
  return value
}

/** Validates the `action` discriminator and teaches the valid set on a miss. */
export function actionOf<A extends string>(
  input: { action?: string },
  allowed: readonly A[]
): A {
  const raw = String(input.action ?? '')
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ToolInputError(`unknown action "${raw}" — use one of: ${allowed.join(' | ')}`)
  }
  return raw as A
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Wraps a merged-tool handler: input mistakes become `{"error": "...use one
 * of..."}` results (the model self-corrects next turn), transport failures
 * keep their message. Anything else bubbles to the SDK as a tool error.
 */
export async function guard(fn: () => Promise<unknown>): Promise<ReturnType<typeof text>> {
  try {
    return text(await fn())
  } catch (err) {
    if (err instanceof ToolInputError) return text({ error: err.message })
    throw err
  }
}
