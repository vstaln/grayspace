import type { GitStatus } from '../git.ts'
import type { GitBranch, GitCommit } from '../../preload/api.ts'
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

  ipcMain.handle('git:branches', async () => {
    try {
      return unwrap(await send<{ branches: GitBranch[]; current: string }>('git.branches', GIT_TARGET, {}))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:log', async (_event, options: unknown) => {
    const opts = (options ?? {}) as { limit?: unknown; query?: unknown }
    try {
      return unwrap(
        await send<{ commits: GitCommit[]; head: string }>('git.log', GIT_TARGET, {
          limit: typeof opts.limit === 'number' ? opts.limit : 100,
          query: typeof opts.query === 'string' ? opts.query : ''
        })
      )
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:checkout', async (_event, ref: unknown) => {
    if (typeof ref !== 'string' || !ref.trim()) return { error: 'a branch or commit is required' }
    try {
      return unwrap(await send<{ branch: string; hash: string }>('git.checkout', GIT_TARGET, { ref }))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:create-branch', async (_event, name: unknown, startPoint?: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return { error: 'a branch name is required' }
    try {
      return unwrap(
        await send<{ branch: string; hash: string }>('git.create-branch', GIT_TARGET, {
          name,
          startPoint: typeof startPoint === 'string' ? startPoint : ''
        })
      )
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
