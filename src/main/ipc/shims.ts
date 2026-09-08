import * as electron from 'electron'







function resolveElectronModule<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const electronAny = electron as unknown as Record<string, any>
      const mockAny = (globalThis as unknown as Record<string, any>).__electronMock || {}
      const target = electronAny[name] ?? mockAny[name]
      const val = target?.[prop]
      if (typeof val === 'function') {
        return val.bind(target)
      }
      return val
    }
  })
}

export const ipcMain = resolveElectronModule<typeof electron.ipcMain>('ipcMain')
export const app = resolveElectronModule<typeof electron.app>('app')
export const dialog = resolveElectronModule<typeof electron.dialog>('dialog')
export const shell = resolveElectronModule<typeof electron.shell>('shell')
export const BrowserWindow = resolveElectronModule<typeof electron.BrowserWindow>('BrowserWindow')
export const session = resolveElectronModule<typeof electron.session>('session')

