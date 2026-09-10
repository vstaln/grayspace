import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'


const maximizeHooked = new WeakSet<object>()

function hookMaximizeEvents(window: Electron.BrowserWindow): void {
  if (maximizeHooked.has(window)) return
  maximizeHooked.add(window)
  window.on('maximize', () => window.webContents.send('window:onMaximizeChange', true))
  window.on('unmaximize', () => window.webContents.send('window:onMaximizeChange', false))
}

export function registerWindowIpc(deps: IpcDeps): void {
  ipcMain.on('window:minimize', () => deps.getWindow()?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    const window = deps.getWindow()
    if (!window) return
    hookMaximizeEvents(window)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on('window:close', () => deps.getWindow()?.close())
  ipcMain.handle('window:is-maximized', () => {
    const window = deps.getWindow()
    if (!window) return false
    hookMaximizeEvents(window)
    return window.isMaximized()
  })
}
