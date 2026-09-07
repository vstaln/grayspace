import { app, protocol } from 'electron'
import * as fs from 'fs'
import { join } from 'path'

/** macOS differs on menus, accelerators and window chrome — checked in all three. */
export const IS_MAC = process.platform === 'darwin'

/**
 * Registers custom schemes as privileged before app.whenReady().
 */
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

/**
 * Session the Browser pane's tabs share. Persistent so logins survive a
 * restart, and separate from the app session so a visited page can never read
 * the workspace's own cookies.
 */
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
  // Allow ambient media, music widgets, and alert sounds to play without requiring an initial user gesture.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  // Hardware acceleration and GPU rasterization for smooth 60+ FPS on Windows and macOS
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-accelerated-2d-canvas')
  // Prevent background throttling so Code view, Canvas, and background terminal streams never lag or freeze
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('use-angle', 'd3d11')
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  }
}

export function requestInstanceLock(): boolean {
  // Development runs must be able to coexist with the installed app. The
  // renderer is served by Vite and is intentionally isolated from production;
  // sharing the production lock otherwise makes Electron hand off and exit.
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
