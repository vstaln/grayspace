import { app, ipcMain, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import updater from 'electron-updater'
import type { AppUpdateState } from '../preload/api.ts'

let registered = false

const UPDATE_FEED = {
  provider: 'github' as const,
  owner: 'orcspace',
  repo: 'Orcspace-Uptade',
  releaseType: 'release' as const
}

const RELEASES_URL = 'https://github.com/orcspace/Orcspace-Uptade/releases/latest'

// electron-updater emits nothing at all when a request hangs (a captive portal,
// a stalled CDN connection), which would leave the button disabled forever.
const STALL_MS = 90_000

/**
 * How this particular installation can update itself.
 *  - `auto`:   download in the background, install on request (Windows NSIS,
 *              signed macOS builds, Linux AppImage and .deb).
 *  - `manual`: the app can only announce a newer release and open its page.
 *              Unsigned macOS builds (Squirrel.Mac refuses to swap an app whose
 *              signature it cannot validate) and Linux tar.gz installs.
 *  - `off`:    development runs.
 */
export type UpdateMode = 'auto' | 'manual' | 'off'

/** Developer ID builds carry a team id; ad-hoc (or unsigned) ones do not. */
function isMacBundleSigned(): boolean {
  try {
    // <Name>.app/Contents/MacOS/<binary> -> <Name>.app
    const bundle = join(dirname(process.execPath), '..', '..')
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8', timeout: 5000 })
    const output = `${result.stderr ?? ''}${result.stdout ?? ''}`
    return result.status === 0 && !/Signature=adhoc/.test(output) && /^TeamIdentifier=(?!not set)\S+/m.test(output)
  } catch {
    return false
  }
}

/** electron-builder drops a `package-type` file next to a .deb/.rpm install. */
function linuxPackageType(): string | undefined {
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function detectMode(): UpdateMode {
  if (!app.isPackaged) return 'off'
  if (process.platform === 'win32') return 'auto'
  if (process.platform === 'darwin') return isMacBundleSigned() ? 'auto' : 'manual'
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return 'auto'
    return linuxPackageType() === 'deb' ? 'auto' : 'manual'
  }
  return 'off'
}

function describeFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error)
  if (/404|cannot find .*\.yml|no published|latest(-\w+)?\.yml/i.test(text)) {
    return 'No published release was found for this platform.'
  }
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|timed out|socket hang up/i.test(text)) {
    return 'Could not reach the update server. Check your connection and try again.'
  }
  if (/code signature|not signed|signature.*(valid|verif)/i.test(text)) {
    return `The update could not be verified. Download it manually from ${RELEASES_URL}`
  }
  return 'Could not update. Please try again.'
}

function initialState(mode: UpdateMode): AppUpdateState {
  const currentVersion = app.getVersion()
  if (mode === 'off') return { status: 'disabled', currentVersion, message: 'Updates are available in the installed app.' }
  if (mode === 'manual') {
    return { status: 'idle', currentVersion, message: 'This installation cannot update itself — new versions are announced here and downloaded manually.' }
  }
  return { status: 'idle', currentVersion }
}

export interface UpdaterHandle {
  /** Quiet check for the periodic timer: failures never surface as errors. */
  checkInBackground(): void
}

export function registerUpdater(): UpdaterHandle {
  if (registered) return { checkInBackground: () => {} }
  registered = true
  let mode: UpdateMode | undefined
  let state: AppUpdateState = { status: 'idle', currentVersion: app.getVersion() }
  let background = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const disarm = (): void => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
  }
  const fail = (error: unknown): void => {
    console.warn('Update failed:', error)
    disarm()
    if (background && state.status === 'checking') {
      // Nobody asked for this check; being offline is not worth an error banner.
      background = false
      state = { currentVersion: state.currentVersion, status: 'idle' }
      return
    }
    state = { ...state, status: 'error', percent: undefined, message: describeFailure(error) }
  }
  const arm = (): void => {
    disarm()
    watchdog = setTimeout(() => fail(new Error('The update check timed out')), STALL_MS)
    // A pending timer must never be the reason the app refuses to quit.
    ;(watchdog as { unref?: () => void }).unref?.()
  }

  // Configured on first use: detecting a macOS signature spawns a process, and
  // nothing needs the answer before Settings or the first background check.
  const configure = (): UpdateMode => {
    if (mode !== undefined) return mode
    mode = detectMode()
    state = initialState(mode)
    if (mode === 'off') return mode
    const { autoUpdater } = updater
    autoUpdater.autoDownload = mode === 'auto'
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.disableDifferentialDownload = false
    // A tar.gz install is not an AppImage, so electron-updater would decline to
    // check at all; we only want it to read the feed and tell us the version.
    if (mode === 'manual' && process.platform === 'linux') autoUpdater.forceDevUpdateConfig = true
    // Keep the feed explicit so installations made before the repository was
    // unified can migrate away from the old, separate update repository.
    autoUpdater.setFeedURL(UPDATE_FEED)
    autoUpdater.on('error', fail)
    autoUpdater.on('checking-for-update', () => { state = { currentVersion: state.currentVersion, status: 'checking' } })
    autoUpdater.on('update-available', (info) => {
      if (mode === 'manual') {
        disarm()
        state = {
          currentVersion: state.currentVersion, status: 'available', version: info.version,
          message: `Version ${info.version} is available. Download it from the releases page.`
        }
        return
      }
      arm()
      state = { ...state, status: 'downloading', version: info.version, percent: 0 }
    })
    autoUpdater.on('update-not-available', () => { disarm(); state = { currentVersion: state.currentVersion, status: 'current' } })
    // Every byte of progress is proof the download is alive, so the stall timer
    // measures silence rather than total download time.
    autoUpdater.on('download-progress', (progress) => { arm(); state = { ...state, status: 'downloading', percent: progress.percent } })
    autoUpdater.on('update-downloaded', (info) => { disarm(); background = false; state = { ...state, status: 'ready', version: info.version, percent: 100 } })
    return mode
  }

  const startCheck = (): void => {
    state = { currentVersion: state.currentVersion, status: 'checking' }
    arm()
    try {
      void updater.autoUpdater.checkForUpdates().then((result) => {
        if (result === null || result === undefined) {
          // electron-updater declined to run (not an updatable install).
          disarm()
          state = { currentVersion: state.currentVersion, status: 'disabled', message: 'This installation cannot check for updates.' }
          return
        }
        void result.downloadPromise?.catch(fail)
      }).catch(fail)
    } catch (error) {
      fail(error)
    }
  }
  const checkable = (): boolean => ['idle', 'current', 'error'].includes(state.status)

  ipcMain.handle('updates:state', () => { configure(); return state })
  ipcMain.handle('updates:check', () => {
    if (configure() === 'off') return state
    if (!checkable()) {
      // The user took over a quiet check: from here on, report its failures.
      background = false
      return state
    }
    background = false
    startCheck()
    return state
  })
  ipcMain.handle('updates:install', () => {
    const current = configure()
    if (current === 'manual' && state.status === 'available') {
      void shell.openExternal(RELEASES_URL)
      return true
    }
    if (current !== 'auto' || state.status !== 'ready') return false
    state = { ...state, status: 'installing' }
    setImmediate(() => {
      // Silent: the NSIS installer runs with /S so the setup wizard never
      // appears — the app just closes, updates in place and relaunches. The
      // flags are ignored by the macOS and AppImage/.deb updaters, which
      // always relaunch.
      try { updater.autoUpdater.quitAndInstall(true, true) } catch (error) { fail(error) }
    })
    return true
  })

  return {
    checkInBackground: () => {
      if (configure() === 'off' || !checkable()) return
      background = true
      startCheck()
    }
  }
}
