import { TASK_MANAGER_TARGET } from '../commands/board.ts'
import { GIT_TARGET } from '../commands/git.ts'
import { ipcMain } from './shims.ts'
import { actor2payload, makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerBoardIpc(deps: IpcDeps): void {
  const { coordination, state, core } = deps
  const send = makeSend(core)

  /** The human's identity on the board, used for role checks and assignment. */
  const actor = (): { role: 'member' | 'lead'; name: string } => ({
    role: state.settings.role,
    name: state.settings.userName
  })

  ipcMain.handle('coordination:status', () => coordination.snapshot())
  ipcMain.handle(
    'coordination:create-task',
    async (_e, input: { title: string; brief?: string; state?: string; tags?: string[]; dueAt?: number; assignee?: string }) =>
      unwrap(await send('task.create', 'task:new', { ...input, title: input?.title ?? '', state: input?.state ?? 'queued' }))
  )
  ipcMain.handle(
    'coordination:update-task',
    async (
      _e,
      id: string,
      patch: {
        state?: string
        title?: string
        brief?: string
        tags?: string[]
        dueAt?: number | null
        assignee?: string | null
        baseVersion?: number
      }
    ) => {
      if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
      return unwrap(await send('task.update', `task:${id}`, { ...patch, ...actor2payload(actor()) }, patch?.baseVersion))
    }
  )
  ipcMain.handle('coordination:delete-task', async (_e, id: string) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
    return unwrap(await send('task.delete', `task:${id}`))
  })
  ipcMain.handle('coordination:reset-manager', async () => {
    await send('manager.release', TASK_MANAGER_TARGET, { force: true })
    return coordination.snapshot()
  })
  /**
   * Operator escape hatch: drop every resource lock, whoever holds it. Not a
   * command — it is the recovery path for when the bus's own gate is what is
   * stuck, and routing it through that gate would be circular.
   */
  ipcMain.handle('coordination:release-locks', () => {
    core.locks.releaseAll()
    return coordination.snapshot()
  })

  // ---- git ----------------------------------------------------------------
  // Status is read by running git in the project folder, never by scraping a
  // terminal. A commit takes `git:repo` on the way through the bus, so a
  // second actor cannot commit a half-written tree underneath the first.
  ipcMain.handle('git:status', async () => unwrap(await send('git.refresh', GIT_TARGET)))
  ipcMain.handle('git:commit', async (_e, message: string) =>
    unwrap(await send('git.commit', GIT_TARGET, { message }))
  )
}
