import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'


export function registerWindowIpc(deps: IpcDeps): void {
  ipcMain.on('window:minimize', () => deps.getWindow()?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    const window = deps.getWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on('window:close', () => deps.getWindow()?.close())
  ipcMain.handle('window:is-maximized', () => deps.getWindow()?.isMaximized() ?? false)
}
