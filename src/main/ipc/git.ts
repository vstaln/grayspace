import type { GitStatus } from '../git.ts'
import { GIT_TARGET } from '../commands/git.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'


export function registerGitIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('git:status', async () =>
    unwrap(await send<GitStatus>('git.refresh', GIT_TARGET, {}))
  )

  ipcMain.handle('git:commit', async (_event, message: unknown) => {
    if (typeof message !== 'string') return { error: 'a commit message is required' }
    return unwrap(await send<{ hash: string }>('git.commit', GIT_TARGET, { message }))
  })
}
