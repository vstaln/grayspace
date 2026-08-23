import type { Command, CommandResult, Core } from '../core/index.ts'

/**
 * The human at the keyboard, as far as the core is concerned. One id for the
 * whole renderer: every window control, every drag, every note edit is the
 * same person, and splitting them would only fragment their locks.
 */
export const USER_ACTOR_ID = 'user'

/** Builds a command submitter for the human's actor over this IPC surface. */
export function makeSend(
  core: Core
): <T>(type: string, target: string, payload?: unknown, baseVersion?: number) => Promise<CommandResult<T>> {
  return <T>(type: string, target: string, payload: unknown = {}, baseVersion?: number): Promise<CommandResult<T>> => {
    const command: Command = { actorId: USER_ACTOR_ID, type, target, payload }
    if (typeof baseVersion === 'number') command.baseVersion = baseVersion
    return core.bus.submit<T>(command)
  }
}

/**
 * Turns a command result into what the renderer's API has always returned:
 * the data on success, `{ error }` on failure. The renderer stays unaware that
 * a bus exists — it asks for a note update and gets a note or a message —
 * while the write itself has already been serialised, version-checked, and
 * journaled on the way through.
 */
export function unwrap<T>(result: CommandResult<T>): T | { error: string; code?: string } {
  if (result.ok) return result.data
  return { error: result.message, code: result.code }
}

/** The board-role fields `task.update` expects from a human editor. */
export function actor2payload(actor: { role: 'member' | 'lead'; name: string }): {
  role: 'member' | 'lead'
  userName: string
} {
  return { role: actor.role, userName: actor.name }
}

/**
 * Quotes one argv token for `cmd.exe /c` so `&`, `|`, and spaces in a user
 * prompt cannot be interpreted as extra commands. `%` is doubled so env-var
 * expansion does not rewrite the argument.
 */
export function quoteWin32CmdArg(value: string): string {
  return `"${String(value).replace(/%/g, '%%').replace(/"/g, '""')}"`
}
