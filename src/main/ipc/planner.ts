import { NEW } from '../commands/index.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerPlannerIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('planner:list', () => deps.planner.list())
  ipcMain.handle(
    'planner:create',
    async (_e, input: { title: string; note?: string; day?: string; time?: string; project?: string; attachments?: string[] }) =>
      unwrap(await send('plan.create', NEW.plan, input))
  )
  ipcMain.handle(
    'planner:update',
    async (
      _e,
      id: string,
      patch: {
        title?: string
        note?: string
        project?: string | null
        day?: string | null
        time?: string | null
        done?: boolean
        order?: number
        attachments?: string[] | null
        baseVersion?: number
      }
    ) => {
      if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
      return unwrap(await send('plan.update', `plan:${id}`, patch, patch?.baseVersion))
    }
  )
  ipcMain.handle(
    'planner:toggle',
    async (_e, id: string, done?: boolean, baseVersion?: number) => {
      if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
      return unwrap(await send('plan.toggle', `plan:${id}`, { done }, baseVersion))
    }
  )
  ipcMain.handle('planner:delete', async (_e, id: string) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
    return unwrap(await send('plan.delete', `plan:${id}`))
  })
}
