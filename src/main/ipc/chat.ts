import * as os from 'os'
import { chatRunner, type ChatModelId } from '../chatRunner.ts'
import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'

const CHAT_MODELS = new Set<ChatModelId>(['codex', 'claude', 'grok', 'antigravity', 'opencode'])
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The chat pane's transport. One headless CLI process per thread (see
 * ChatRunner), streams cleaned answer text to the renderer through
 * `chat:onData` and settles the bubble on `chat:onExit`.
 */
export function registerChatIpc(deps: IpcDeps): void {
  const push = (channel: string, threadId: string, payload: unknown): void => {
    const win = deps.getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, threadId, payload)
  }

  chatRunner.on('data', (threadId: string, chunk: string) => {
    push('chat:onData', threadId, chunk)
  })
  chatRunner.on('exit', (threadId: string, payload: unknown) => {
    push('chat:onExit', threadId, payload)
  })

  ipcMain.handle(
    'chat:send',
    (_e, threadId: unknown, model: unknown, prompt: unknown): { ok: true } | { error: string } => {
      if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) {
        return { error: 'invalid thread id' }
      }
      if (typeof model !== 'string' || !CHAT_MODELS.has(model as ChatModelId)) {
        return { error: 'unknown model' }
      }
      if (typeof prompt !== 'string') return { error: 'invalid prompt' }
      const cwd = deps.getWorkspaceDir() || os.homedir()
      return chatRunner.send(threadId, model as ChatModelId, prompt, cwd)
    }
  )

  ipcMain.handle('chat:stop', (_e, threadId: unknown): { ok: boolean } => {
    if (typeof threadId !== 'string') return { ok: false }
    return { ok: chatRunner.stop(threadId) }
  })

  ipcMain.handle('chat:dispose', (_e, threadId: unknown): { ok: boolean } => {
    if (typeof threadId !== 'string') return { ok: false }
    chatRunner.dispose(threadId)
    return { ok: true }
  })
}
