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
    if (!patch || typeof patch !== 'object') return state.publicSettings()
    const next = state.patchSettings(patch)
    return next
  })


  const backgroundDir = (): string => join(app.getPath('userData'), BACKGROUND_DIR_NAME)

  const backgroundDataUrl = async (): Promise<string | null> => {
    const path = state.settings.backgroundImage
    if (!path) return null
    try {
      const url = await media.dataUrl(path)

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



      if ((await fs.promises.stat(source)).size > media.MAX_MEDIA_BYTES)
        return { error: 'File exceeds 256 MB — please select a smaller image.' }

      const dir = backgroundDir()
      await fs.promises.mkdir(dir, { recursive: true })
      const rawExt = extname(source).toLowerCase() || '.png'



      const safeExt = media.IMAGE_EXTENSIONS.includes(rawExt.slice(1)) ? rawExt : '.png'
      const target = join(dir, `background-${Date.now()}${safeExt}`)

      // Copy the replacement in first, before touching anything that
      // currently works. A failed copy (disk full, source gone mid-pick)
      // must leave the existing background exactly as it was instead of
      // deleting it out from under a setting that still points to it. This
      // also makes re-picking the currently active background (itself a
      // file inside `dir`) safe: `source` survives until `target` exists.
      await fs.promises.copyFile(source, target)
      for (const name of await fs.promises.readdir(dir)) {
        const full = join(dir, name)
        if (full === target) continue
        try {
          await fs.promises.rm(full, { force: true })
        } catch {

        }
      }
      state.patchSettings({ backgroundImage: target })
      return { dataUrl: await backgroundDataUrl() }
    } catch (err) {
      return { error: `Failed to read file: ${String(err)}` }
    }
  })
  ipcMain.handle('settings:clear-background', async () => {
    state.patchSettings({ backgroundImage: null })
    try {



      await fs.promises.rm(backgroundDir(), { recursive: true, force: true })
    } catch {

    }
    return null
  })
}
