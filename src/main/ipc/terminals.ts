import { MAX_TERMINAL_WRITE_BYTES } from '../config.ts'
import { TERMINAL_ID } from '../terminals.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import {
  markTerminalMounted,
  setFocusedTerminal,
  unmarkTerminalMounted
} from './terminalFocus.ts'
import type { IpcDeps } from './types.ts'

/**
 * Keystrokes go through the bus like everything else, which is what makes an
 * agent holding `terminal:<id>` actually keep the user out of that shell
 * instead of the two interleaving characters into one command line.
 */
export function registerTerminalIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('terminal:create', async (_e, id: string, cols?: number, rows?: number) => {
    // Without this a junk id would sit in mountedTerminals forever: spawn
    // rejects it later (same format rule), but nothing ever calls
    // terminal:detach for it, so isTerminalMounted() would keep reporting a
    // phantom as mounted and the Set would grow on every junk create call.
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) {
      return { ok: false, error: 'terminal id is required' }
    }
    markTerminalMounted(id)
    try {
      const result = unwrap(await send<{ ok: boolean; error?: string }>('terminal.spawn', `terminal:${id}`, { cols, rows }))
      // A reservation that failed to spawn has no renderer stream to receive
      // events. Leaving it marked mounted makes the main process believe a
      // dead widget still owns the terminal and leaks the id in the focus set.
      if (!('ok' in result) || result.ok !== true) unmarkTerminalMounted(id)
      return result
    } catch (err) {
      unmarkTerminalMounted(id)
      throw err
    }
  })
  ipcMain.on('terminal:detach', (_e, id: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) return
    unmarkTerminalMounted(id)
  })
  ipcMain.handle('terminal:write', async (_e, id: string, data: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) {
      return { ok: false, error: 'invalid terminal id' }
    }
    if (typeof data !== 'string') {
      return { ok: false, error: 'invalid write data' }
    }
    // Bytes, not UTF-16 code units: the pty and the inner `terminal.input`
    // gate both measure UTF-8 bytes, so a unit mismatch here let emoji-heavy
    // writes past IPC only to be rejected deeper with a confusing message.
    if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_WRITE_BYTES) {
      return { ok: false, error: `write exceeds ${MAX_TERMINAL_WRITE_BYTES} bytes` }
    }
    return unwrap(await send('terminal.input', `terminal:${id}`, { data }))
  })
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return
    // Best-effort: a resize rejected under queue backpressure would otherwise
    // surface as an unhandled promise rejection.
    void send('terminal.resize', `terminal:${id}`, { cols, rows }).catch(() => {})
  })
  ipcMain.handle('terminal:dispose', async (_e, id: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) {
      return { ok: false, error: 'invalid terminal id' }
    }
    const result = unwrap(await send('terminal.dispose', `terminal:${id}`))
    // A dispose can be rejected while an agent owns the terminal lock. Keep
    // the live widget marked as mounted in that case; clearing it early makes
    // focus routing believe the shell disappeared even though it is still
    // running and visible.
    if (!(result && typeof result === 'object' && 'error' in result)) unmarkTerminalMounted(id)
    return result
  })
  ipcMain.handle('terminal:set-title', async (_e, id: string, title: string) => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id) || typeof title !== 'string') {
      return { ok: false, error: 'invalid terminal id or title' }
    }
    // Titles are rebroadcast to every window and persisted; cap length so a
    // hostile renderer cannot bloat the bus journal or stored snapshots.
    const clean = title.trim().slice(0, 200)
    if (!clean) return { ok: false, error: 'invalid terminal id or title' }
    deps.terminals.setTitle(id, clean)
    deps.getWindow()?.webContents.send('control:rename-widget', { id, title: clean })
    return { ok: true }
  })
  /** The renderer reports which terminal holds keyboard focus, if any. */
  ipcMain.on('terminal:focus', (_e, focused: boolean, id?: string) => {
    setFocusedTerminal(focused && typeof id === 'string' && TERMINAL_ID.test(id) ? id : null)
  })
}
