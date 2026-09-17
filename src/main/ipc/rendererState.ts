import { ipcMain } from 'electron'
import type { IpcDeps } from './types.ts'

export function registerRendererStateIpc(deps: IpcDeps): void {
  ipcMain.handle('renderer-state:load', () => deps.rendererState.snapshot())
  ipcMain.handle('renderer-state:replace', (_event, values: unknown) => deps.rendererState.replace(values))
  ipcMain.handle('renderer-state:set', (_event, key: unknown, value: unknown) => ({ ok: deps.rendererState.set(key, value) }))
  ipcMain.handle('renderer-state:remove', (_event, key: unknown) => ({ ok: deps.rendererState.remove(key) }))
}
