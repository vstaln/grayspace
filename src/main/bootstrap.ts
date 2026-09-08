import { app, protocol } from 'electron'
import * as fs from 'fs'
import { join } from 'path'


export const IS_MAC = process.platform === 'darwin'




export function registerProtocols(): void {
  if (protocol && typeof protocol.registerSchemesAsPrivileged === 'function') {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'orc',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true
        }
      }
    ])
  }
}






export const BROWSER_PARTITION = 'persist:orcspace-browser'

export function getPreloadPath(): string {
  const candidates = [
    join(__dirname, '../preload/index.cjs'),
    join(__dirname, '../preload/index.js'),
    join(__dirname, '../preload/index.mjs')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return join(__dirname, '../preload/index.cjs')
}

export function initAppSwitches(): void {

  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-accelerated-2d-canvas')



  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384')

  app.commandLine.appendSwitch('disk-cache-size', '33554432')
  app.commandLine.appendSwitch('media-cache-size', '33554432')

  app.commandLine.appendSwitch('disable-breakpad')
  app.commandLine.appendSwitch('disable-component-update')
  app.commandLine.appendSwitch('disable-domain-reliability')
  app.commandLine.appendSwitch('disable-features', 'MediaRouter')

  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('use-angle', 'd3d11')
  }
}

export function requestInstanceLock(): boolean {



  if (!app.isPackaged) return true
  const hasLock = app.requestSingleInstanceLock()
  if (!hasLock) {
    console.warn('Another OrcSpace instance is already running — handing off and exiting.')
    app.exit(0)
  }
  return hasLock
}

export function initAutoUpdater(): void {
  if (!app.isPackaged) return
  import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.logger = console
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
        console.warn('Auto-updater check failed:', err)
      })
    })
    .catch(() => {})
}
