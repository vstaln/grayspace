import * as fs from 'fs'
import { extname, join } from 'path'
import { BACKGROUND_DIR_NAME } from '../config.ts'
import * as media from '../media.ts'
import { app, dialog, ipcMain } from './shims.ts'
import type { IpcDeps, SettingsPatch } from './types.ts'

export function registerSettingsIpc(deps: IpcDeps): void {
  const { state } = deps

  ipcMain.handle('settings:get', () => state.publicSettings())
  ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => {
    const next = state.patchSettings(patch ?? {})
    return next
  })

  // ---- wallpaper ---------------------------------------------------------
  const backgroundDir = (): string => join(app.getPath('userData'), BACKGROUND_DIR_NAME)

  const backgroundDataUrl = async (): Promise<string | null> => {
    const path = state.settings.backgroundImage
    if (!path) return null
    try {
      const url = await media.dataUrl(path)
      // The copy was deleted out from under us — forget it instead of retrying forever.
      if (!url) state.patchSettings({ backgroundImage: null })
      return url
    } catch {
      return null
    }
  }

  ipcMain.handle('settings:get-background', () => backgroundDataUrl())
  ipcMain.handle('settings:pick-background', async () => {
    const window = deps.getWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: media.IMAGE_EXTENSIONS }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const source = result.canceled ? null : result.filePaths[0]
    if (!source) return { dataUrl: await backgroundDataUrl() }
    if (!media.isLocalPath(source)) {
      return { error: 'UNC and network paths are not allowed' }
    }

    try {
      // Async variants throughout: the copy can be a full 24 MB, and a sync
      // stat/mkdir/copy chain here froze every PTY chunk and IPC reply for the
      // duration (PERF-wallpaper-async).
      if ((await fs.promises.stat(source)).size > media.MAX_MEDIA_BYTES)
        return { error: 'File exceeds 24 MB — please select a smaller image.' }

      const dir = backgroundDir()
      await fs.promises.mkdir(dir, { recursive: true })
      // One wallpaper at a time: clearing the folder first keeps old copies from
      // accumulating in userData every time the picture is changed.
      for (const name of await fs.promises.readdir(dir)) {
        try {
          await fs.promises.rm(join(dir, name), { force: true })
        } catch {
          /* a locked leftover must not block the new pick */
        }
      }
      const target = join(dir, `background-${Date.now()}${extname(source).toLowerCase() || '.png'}`)
      await fs.promises.copyFile(source, target)
      state.patchSettings({ backgroundImage: target })
      return { dataUrl: await backgroundDataUrl() }
    } catch (err) {
      return { error: `Failed to read file: ${String(err)}` }
    }
  })
  ipcMain.handle('settings:clear-background', () => {
    state.patchSettings({ backgroundImage: null })
    try {
      fs.rmSync(backgroundDir(), { recursive: true, force: true })
    } catch {
      /* the setting is already cleared; a stale copy on disk is harmless */
    }
    return null
  })
}
