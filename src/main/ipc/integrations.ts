import * as media from '../media.ts'
import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'

export function registerIntegrationsIpc(_deps: IpcDeps): void {

  ipcMain.handle('media:save-clipboard', () => media.saveClipboardImage())

  ipcMain.handle('media:save-clipboard-scratch', () => media.saveClipboardImageToScratch())

  ipcMain.handle('media:save-bytes', (_e, bytes: Uint8Array, ext: string) => {
    if (!bytes?.byteLength) return null
    if (bytes.byteLength > media.MAX_MEDIA_BYTES) return { error: 'Image exceeds 24 MB' }
    return media.saveBytes(Buffer.from(bytes), ext || 'png')
  })
  ipcMain.handle('media:save-bytes-scratch', (_e, bytes: Uint8Array, ext: string) => {
    if (!bytes?.byteLength) return null
    if (bytes.byteLength > media.MAX_MEDIA_BYTES) return { error: 'Image exceeds 24 MB' }
    return media.saveBytesToScratch(Buffer.from(bytes), ext || 'png')
  })
  ipcMain.handle('media:data-url', (_e, path: string) =>
    typeof path === 'string' && media.hasMediaExtension(path) ? media.dataUrl(path) : null
  )
}
