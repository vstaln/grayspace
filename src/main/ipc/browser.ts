import { ipcMain, session } from './shims.ts'
import type { IpcDeps } from './types.ts'

const BROWSER_PARTITION = 'persist:orcspace-browser'

/**
 * Browser IPC: allows clearing partition cache and cookies for a clean reset.
 */
export function registerBrowserIpc(_deps: IpcDeps): void {
  ipcMain.handle('browser:clear-data', async () => {
    try {
      if (session && typeof session.fromPartition === 'function') {
        const ses = session.fromPartition(BROWSER_PARTITION)
        await ses.clearStorageData({
          storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage']
        })
        await ses.clearCache()
      }
      return { ok: true }
    } catch (err) {
      console.error('failed to clear browser partition data', err)
      return { ok: false, error: String(err) }
    }
  })
}
