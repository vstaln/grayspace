import type { GitStatus } from '../git.ts'
import { GIT_TARGET } from '../commands/git.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'


export function registerGitIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('git:status', async () => {
    try {
      return unwrap(await send<GitStatus>('git.refresh', GIT_TARGET, {}))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:commit', async (_event, message: unknown) => {
    if (typeof message !== 'string' || !message.trim()) return { error: 'a commit message is required' }
    if (message.length > 10_000) return { error: 'commit message is too long' }
    try {
      return unwrap(await send<{ hash: string }>('git.commit', GIT_TARGET, { message }))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
