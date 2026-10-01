import { MAX_TERMINAL_WRITE_BYTES } from '../config.ts'
import { TERMINAL_ID } from '../terminals.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import {
  blurTerminal,
  forgetTerminalMounted,
  isTerminalMounted,
  markTerminalMounted,
  setFocusedTerminal,
  unmarkTerminalMounted
} from './terminalFocus.ts'
import type { IpcDeps } from './types.ts'






export function registerTerminalIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('terminal:list', () =>
    deps.terminals.list().map((terminal) => ({
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.cwd,
      lastPrompt: terminal.lastPrompt
    }))
  )

  ipcMain.handle('terminal:create', async (_e, id: string, cols?: number, rows?: number, title?: string) => {




    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) {
      return { ok: false, error: 'terminal id is required' }
    }
    // The mark belongs to the widget until detach, even if spawning fails.
    // A delayed failure must not consume a replacement widget's mount.
    markTerminalMounted(id)
    try {
      const payload = title === undefined ? { cols, rows } : { cols, rows, title }
      return unwrap(await send<{ ok: boolean; error?: string }>('terminal.spawn', `terminal:${id}`, payload))
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.on('terminal:detach', (_e, id: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) return
    unmarkTerminalMounted(id)
    if (!isTerminalMounted(id)) deps.terminals.resetRendererOutput(id)
  })
  ipcMain.on('terminal:ack-output', (_e, id: string, deliveryId: number) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) return
    if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) return
    deps.terminals.acknowledgeRendererOutput(id, deliveryId)
  })
  ipcMain.handle('terminal:write', async (_e, id: string, data: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) {
      return { ok: false, error: 'invalid terminal id' }
    }
    if (typeof data !== 'string') {
      return { ok: false, error: 'invalid write data' }
    }



    if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_WRITE_BYTES) {
      return { ok: false, error: `write exceeds ${MAX_TERMINAL_WRITE_BYTES} bytes` }
    }
    return unwrap(await send('terminal.input', `terminal:${id}`, { data }))
  })
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return


    void send('terminal.resize', `terminal:${id}`, { cols, rows }).catch(() => {})
  })
  ipcMain.handle('terminal:dispose', async (_e, id: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) {
      return { ok: false, error: 'invalid terminal id' }
    }
    const result = unwrap(await send('terminal.dispose', `terminal:${id}`))




    // Disposed for good (the id is banned from here on), so drop every
    // outstanding mount rather than decrementing one of them.
    if (!(result && typeof result === 'object' && 'error' in result)) forgetTerminalMounted(id)
    return result
  })
  ipcMain.handle('terminal:set-title', async (_e, id: string, title: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id) || typeof title !== 'string') {
      return { ok: false, error: 'invalid terminal id or title' }
    }


    const clean = title.trim().slice(0, 200)
    if (!clean) return { ok: false, error: 'invalid terminal id or title' }
    deps.terminals.setTitle(id, clean)
    deps.getWindow()?.webContents.send('control:rename-widget', { id, title: clean })
    return { ok: true }
  })
  ipcMain.handle('terminal:set-last-prompt', (_e, id: string, prompt: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id) || typeof prompt !== 'string') {
      return { ok: false, error: 'invalid terminal id or prompt' }
    }
    deps.terminals.rememberPrompt(id, prompt)
    return { ok: true }
  })

  ipcMain.on('terminal:focus', (_e, focused: boolean, id?: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) return
    // Blur is scoped to the reporting terminal: a widget going away must not
    // clear focus that another terminal has already taken.
    if (focused) setFocusedTerminal(id)
    else blurTerminal(id)
  })
}
