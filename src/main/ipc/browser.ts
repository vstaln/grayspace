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
        // Полная очистка: куки, localStorage, IndexedDB, ServiceWorkers, кэш, shader, websql и т.д.
        // Следы браузера -> 0. Срабатывает без перезапуска.
        await (ses.clearStorageData as unknown as (opts: unknown) => Promise<void>)({
          storages: [
            'cookies',
            'filesystem',
            'indexdb',
            'localstorage',
            'shadercache',
            'serviceworkers',
            'cachestorage'
          ]
        })
        await ses.clearCache()
        // Дополнительные слои Chromium
        try { await (ses as unknown as { clearHostResolverCache?: () => Promise<void> }).clearHostResolverCache?.() } catch {}
        try { await (ses as unknown as { clearAuthCache?: () => Promise<void> }).clearAuthCache?.() } catch {}
        try { await (ses as unknown as { clearCodeCaches?: (opts: unknown) => Promise<void> }).clearCodeCaches?.({}) } catch {}
        try { (ses as unknown as { flushStorageData?: () => void }).flushStorageData?.() } catch {}
        try { await (ses as unknown as { clearData?: (opts: unknown) => Promise<void> }).clearData?.({}) } catch {}
      }
      return { ok: true }
    } catch (err) {
      console.error('failed to clear browser partition data', err)
      return { ok: false, error: String(err) }
    }
  })
}
