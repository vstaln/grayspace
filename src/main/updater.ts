import { app, ipcMain } from 'electron'
import updater from 'electron-updater'
import type { AppUpdateState } from '../preload/api.ts'

let registered = false

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
  const fail = (error: unknown): void => {
    console.warn('Update failed:', error)
    state = { ...state, status: 'error', message: 'Could not update. Check your connection and try again. A published release must be available.' }
  }
  autoUpdater.on('error', fail)
  autoUpdater.on('checking-for-update', () => { state = { currentVersion: state.currentVersion, status: 'checking' } })
  autoUpdater.on('update-available', (info) => { state = { ...state, status: 'downloading', version: info.version, percent: 0 } })
  autoUpdater.on('update-not-available', () => { state = { ...state, status: 'current' } })
  autoUpdater.on('download-progress', (progress) => { state = { ...state, status: 'downloading', percent: progress.percent } })
  autoUpdater.on('update-downloaded', (info) => { state = { ...state, status: 'ready', version: info.version, percent: 100 } })
  ipcMain.handle('updates:state', () => state)
  ipcMain.handle('updates:check', () => {
    if (!['idle', 'current', 'error'].includes(state.status)) return state
    state = { currentVersion: state.currentVersion, status: 'checking' }
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
      try { autoUpdater.quitAndInstall(false, true) } catch (error) { fail(error) }
    })
    return true
  })
}
