import * as electron from 'electron'

/**
 * The real electron APIs, or whatever `globalThis.__electronMock` installed —
 * the IPC test suite runs these registrars in a plain Node process with a
 * hand-rolled ipcMain. Resolved once at first import and shared by every
 * registrar module.
 */
const electronAny = electron as unknown as Record<string, any>
const mockAny = (globalThis as unknown as Record<string, any>).__electronMock || {}

export const ipcMain = (electronAny.ipcMain ?? mockAny.ipcMain) as typeof electron.ipcMain
export const app = (electronAny.app ?? mockAny.app) as typeof electron.app
export const dialog = (electronAny.dialog ?? mockAny.dialog) as typeof electron.dialog
export const shell = (electronAny.shell ?? mockAny.shell) as typeof electron.shell
export const BrowserWindow = (electronAny.BrowserWindow ?? mockAny.BrowserWindow) as typeof electron.BrowserWindow
