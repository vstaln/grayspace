import { NEW } from '../commands/index.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerBrainIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('brain:list', () => deps.brain.snapshot())
  ipcMain.handle('brain:get', (_e, id: string) =>
    typeof id === 'string' && id ? deps.brain.get(id) : null
  )
  ipcMain.handle('brain:create', async (_e, input) => unwrap(await send('note.create', NEW.note, input ?? {})))
  ipcMain.handle('brain:update', async (_e, id: string, patch) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
    return unwrap(await send('note.update', `note:${id}`, patch ?? {}, (patch as { baseVersion?: number })?.baseVersion))
  })
  ipcMain.handle('brain:delete', async (_e, id: string) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
    return unwrap(await send('note.delete', `note:${id}`))
  })
  ipcMain.handle('brain:trash', () => deps.brain.trash())
  ipcMain.handle('brain:restore', async (_e, id: string) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
    return unwrap(await send('note.restore', `note:${id}`))
  })
  ipcMain.handle('brain:purge', async (_e, id: string) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' }
    return unwrap(await send('note.purge', `note:${id}`))
  })
}
