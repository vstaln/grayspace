import { mcpUrl } from '../config.ts'
import * as media from '../media.ts'
import { ipcMain } from './shims.ts'
import { mcpStatus, restartMcpServer } from '../mcpProcess.ts'
import type { IpcDeps } from './types.ts'

export function registerIntegrationsIpc(deps: IpcDeps): void {
  // ---- MCP server --------------------------------------------------------
  ipcMain.handle('mcp:getStatus', () => mcpStatus())
  ipcMain.handle('mcp:getUrl', () => mcpUrl())
  ipcMain.handle('mcp:restart', () => restartMcpServer())

  // ---- pasted pictures ---------------------------------------------------
  ipcMain.handle('media:save-clipboard', () => media.saveClipboardImage())
  /** Terminal paste: a throwaway path in the temp dir, not the durable store. */
  ipcMain.handle('media:save-clipboard-scratch', () => media.saveClipboardImageToScratch())
  /** Paste of a real File: the renderer already holds the bytes, so it sends them. */
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
    typeof path === 'string' && media.hasImageExtension(path) ? media.dataUrl(path) : null
  )
}
