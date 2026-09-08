import type { Command, CommandResult, Core } from '../core/index.ts'






export const USER_ACTOR_ID = 'user'


export function makeSend(
  core: Core
): <T>(type: string, target: string, payload?: unknown, baseVersion?: number) => Promise<CommandResult<T>> {
  return <T>(type: string, target: string, payload: unknown = {}, baseVersion?: number): Promise<CommandResult<T>> => {
    const command: Command = { actorId: USER_ACTOR_ID, type, target, payload }
    if (typeof baseVersion === 'number') command.baseVersion = baseVersion
    return core.flow.submit<T>(command)
  }
}








export function unwrap<T>(result: CommandResult<T>): T | { error: string; code?: string } {
  if (result.ok) return result.data
  return { error: result.message, code: result.code }
}






export function quoteWin32CmdArg(value: string): string {
  return `"${String(value).replace(/%/g, '%%').replace(/"/g, '""')}"`
}
