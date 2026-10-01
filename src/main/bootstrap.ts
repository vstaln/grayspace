import { app, protocol } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { registerUpdater } from './updater.ts'


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

  // Production windows use Chromium's compositor. Keep the software path
  // available for CI/smoke runs that explicitly pass --disable-gpu, but do
  // not accidentally carry that diagnostic mode into a normal install.
  const softwareRendering =
    process.env.ORCSPACE_DISABLE_GPU === '1' ||
    process.argv.some((arg) => arg === '--disable-gpu' || arg === '--disable-gpu-compositing')
  if (!softwareRendering) {
    app.commandLine.appendSwitch('enable-gpu')
    app.commandLine.appendSwitch('enable-gpu-compositing')
    app.commandLine.appendSwitch('enable-gpu-rasterization')
    app.commandLine.appendSwitch('enable-zero-copy')
    app.commandLine.appendSwitch('enable-accelerated-2d-canvas')
  }



  // Let V8 size its heap for the machine. A fixed 384MB limit applies to the
  // entire renderer, including every terminal's 5000-line scrollback.

  app.commandLine.appendSwitch('disk-cache-size', '33554432')
  app.commandLine.appendSwitch('media-cache-size', '33554432')

  app.commandLine.appendSwitch('disable-breakpad')
  app.commandLine.appendSwitch('disable-component-update')
  app.commandLine.appendSwitch('disable-domain-reliability')
  app.commandLine.appendSwitch('disable-features', 'MediaRouter')

  if (process.platform === 'win32' && !softwareRendering) {
    app.commandLine.appendSwitch('use-angle', 'd3d11')
  }
}

export function requestInstanceLock(): boolean {



  if (!app.isPackaged && !process.env.ORCSPACE_DEV_USER_DATA) {
    try {
      const pathMod = require('path') as typeof import('path')
      const osMod = require('os') as typeof import('os')
      app.setPath('userData', pathMod.join(osMod.tmpdir(), `orcspace-dev-${process.pid}`))
    } catch {

    }
  }
  const hasLock = app.requestSingleInstanceLock()
  if (!hasLock) {
    console.warn('Another OrcSpace instance is already running — handing off and exiting.')
  }
  return hasLock
}

/** First quiet check shortly after launch, then every few hours. */
const UPDATE_FIRST_CHECK_MS = 30_000
const UPDATE_RECHECK_MS = 4 * 60 * 60 * 1000

export function initAutoUpdater(): void {
  const updates = registerUpdater()
  // Quiet checks only: a download may start, but installing always waits for
  // the user, because it closes every running terminal. Both timers are
  // unref'd so they never keep a quitting app alive.
  setTimeout(() => updates.checkInBackground(), UPDATE_FIRST_CHECK_MS).unref()
  setInterval(() => updates.checkInBackground(), UPDATE_RECHECK_MS).unref()
}
