import { mcpUrl } from '../config.ts'
import * as media from '../media.ts'
import { ipcMain } from './shims.ts'
import { mcpStatus, restartMcpServer } from '../mcpProcess.ts'
import type { IpcDeps } from './types.ts'

export function registerIntegrationsIpc(deps: IpcDeps): void {
  const { state } = deps

  // ---- MCP server --------------------------------------------------------
  ipcMain.handle('mcp:getStatus', () => mcpStatus())
  ipcMain.handle('mcp:getUrl', () => mcpUrl())
  ipcMain.handle('mcp:restart', () => restartMcpServer())

  // ---- Telegram integration ---------------------------------------------
  if (deps.telegram) {
    const telegram = deps.telegram
    ipcMain.handle('integrations:telegram:getStatus', () => telegram.getStatus())
    ipcMain.handle(
      'integrations:telegram:save',
      (
        _e,
        patch: {
          telegramBotToken?: string | null
          telegramUserId?: string | null
          telegramChatId?: string | null
          targetTerminalId?: string | null
        }
      ) => {
        try {
          state.patchSettings({
            ...(patch && 'telegramBotToken' in patch ? { telegramBotToken: patch.telegramBotToken } : {}),
            ...(patch && 'telegramUserId' in patch ? { telegramUserId: patch.telegramUserId ?? undefined } : {}),
            ...(patch && 'telegramChatId' in patch ? { telegramChatId: patch.telegramChatId ?? undefined } : {}),
            ...(patch && 'targetTerminalId' in patch
              ? { targetTerminalId: patch.targetTerminalId ?? undefined }
              : {})
          })
          telegram.refresh()
          return telegram.getStatus()
        } catch (err) {
          return { state: 'error' as const, error: err instanceof Error ? err.message : String(err) }
        }
      }
    )
    ipcMain.handle('integrations:telegram:testSend', () => telegram.testSend())
  } else {
    const unavailable = { state: 'error' as const, error: 'Telegram is not available in this session' }
    ipcMain.handle('integrations:telegram:getStatus', () => unavailable)
    ipcMain.handle('integrations:telegram:save', () => unavailable)
    ipcMain.handle('integrations:telegram:testSend', () => ({ error: unavailable.error }))
  }

  // ---- pasted pictures ---------------------------------------------------
  ipcMain.handle('media:save-clipboard', () => media.saveClipboardImage())
  /** Paste of a real File: the renderer already holds the bytes, so it sends them. */
  ipcMain.handle('media:save-bytes', (_e, bytes: Uint8Array, ext: string) => {
    if (!bytes?.byteLength) return null
    if (bytes.byteLength > media.MAX_MEDIA_BYTES) return { error: 'Image exceeds 24 MB' }
    return media.saveBytes(Buffer.from(bytes), ext || 'png')
  })
  ipcMain.handle('media:data-url', (_e, path: string) =>
    typeof path === 'string' && media.hasImageExtension(path) ? media.dataUrl(path) : null
  )
}
