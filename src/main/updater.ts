import { app, ipcMain } from 'electron'
import updater from 'electron-updater'
import type { AppUpdateState } from '../preload/api.ts'

let registered = false

const UPDATE_FEED = {
  provider: 'github' as const,
  owner: 'orcspace',
  repo: 'Orcspace-Uptade',
  releaseType: 'release' as const
}

// electron-updater emits nothing at all when a request hangs (a captive portal,
// a stalled CDN connection), which would leave the button disabled forever.
const STALL_MS = 90_000

function describeFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error)
  if (/404|cannot find .*\.yml|no published|latest\.yml/i.test(text)) {
    return 'No published release was found. A release with latest.yml must be available.'
  }
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|timed out|socket hang up/i.test(text)) {
    return 'Could not reach the update server. Check your connection and try again.'
  }
  return 'Could not update. Please try again.'
}

export function registerUpdater(): void {
  if (registered) return
  registered = true
  const { autoUpdater } = updater
  let state: AppUpdateState = {
    status: app.isPackaged && process.platform === 'win32' ? 'idle' : 'disabled',
    currentVersion: app.getVersion(),
    message: !app.isPackaged ? 'Updates are available in the installed app.'
      : process.platform !== 'win32' ? 'In-app updates are currently available on Windows.' : undefined
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.disableDifferentialDownload = false
  // Keep the feed explicit so installations made before the repository was
  // unified can migrate away from the old, separate update repository.
  autoUpdater.setFeedURL(UPDATE_FEED)
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const disarm = (): void => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
  }
  const fail = (error: unknown): void => {
    console.warn('Update failed:', error)
    disarm()
    state = { ...state, status: 'error', percent: undefined, message: describeFailure(error) }
  }
  const arm = (): void => {
    disarm()
    watchdog = setTimeout(() => fail(new Error('The update check timed out')), STALL_MS)
    // A pending timer must never be the reason the app refuses to quit.
    ;(watchdog as { unref?: () => void }).unref?.()
  }
  autoUpdater.on('error', fail)
  autoUpdater.on('checking-for-update', () => { state = { currentVersion: state.currentVersion, status: 'checking' } })
  autoUpdater.on('update-available', (info) => { arm(); state = { ...state, status: 'downloading', version: info.version, percent: 0 } })
  autoUpdater.on('update-not-available', () => { disarm(); state = { currentVersion: state.currentVersion, status: 'current' } })
  // Every byte of progress is proof the download is alive, so the stall timer
  // measures silence rather than total download time.
  autoUpdater.on('download-progress', (progress) => { arm(); state = { ...state, status: 'downloading', percent: progress.percent } })
  autoUpdater.on('update-downloaded', (info) => { disarm(); state = { ...state, status: 'ready', version: info.version, percent: 100 } })
  ipcMain.handle('updates:state', () => state)
  ipcMain.handle('updates:check', () => {
    if (!['idle', 'current', 'error'].includes(state.status)) return state
    state = { currentVersion: state.currentVersion, status: 'checking' }
    arm()
    try {
      void autoUpdater.checkForUpdates().then((result) => {
        void result?.downloadPromise?.catch(fail)
      }).catch(fail)
    } catch (error) {
      fail(error)
    }
    return state
  })
  ipcMain.handle('updates:install', () => {
    if (state.status !== 'ready') return false
    state = { ...state, status: 'installing' }
    setImmediate(() => {
      // Silent: the NSIS installer runs with /S so the setup wizard never
      // appears — the app just closes, updates in place and relaunches.
      try { autoUpdater.quitAndInstall(true, true) } catch (error) { fail(error) }
    })
    return true
  })
}
