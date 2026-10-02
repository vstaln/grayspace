import * as media from '../media.ts'
import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'

export function registerIntegrationsIpc(_deps: IpcDeps): void {

  ipcMain.handle('media:save-clipboard', async () => {
    try {
      return media.saveClipboardImage()
    } catch {
      return null
    }
  })

  ipcMain.handle('media:save-clipboard-scratch', async () => {
    try {
      return media.saveClipboardImageToScratch()
    } catch {
      return null
    }
  })

  ipcMain.handle('media:read-clipboard-text', () => media.readClipboardText())

  ipcMain.handle('media:write-clipboard-text', async (_e, text: unknown) =>
    typeof text === 'string' ? media.writeClipboardText(text) : { error: 'Invalid clipboard text' }
  )

  ipcMain.handle('media:stage-clipboard-image', async (_e, bytes: Uint8Array) => {
    if (!bytes || !(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > media.MAX_MEDIA_BYTES) {
      return { error: 'invalid image data' }
    }
    try {
      return media.stageClipboardImage(Buffer.from(bytes))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('media:save-bytes', (_e, bytes: Uint8Array, ext: string) => {
    if (!bytes?.byteLength) return null
    if (bytes.byteLength > media.MAX_MEDIA_BYTES) return { error: 'Image exceeds 256 MB' }
    try {
      return media.saveBytes(Buffer.from(bytes), ext || 'png')
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('media:save-bytes-scratch', (_e, bytes: Uint8Array, ext: string) => {
    if (!bytes?.byteLength) return null
    if (bytes.byteLength > media.MAX_MEDIA_BYTES) return { error: 'Image exceeds 256 MB' }
    try {
      return media.saveBytesToScratch(Buffer.from(bytes), ext || 'png')
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('media:data-url', (_e, path: string) => {
    if (typeof path !== 'string' || !media.hasMediaExtension(path)) return null
    try {
      return media.dataUrl(path)
    } catch {
      return null
    }
  })
}
