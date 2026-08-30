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
    return unwrap(await send<{ ok: boolean; error?: string }>('terminal.spawn', `terminal:${id}`, { cols, rows }))
  })
  ipcMain.on('terminal:detach', (_e, id: string) => {
    unmarkTerminalMounted(id)
  })
  ipcMain.handle('terminal:write', async (_e, id: string, data: string) => {
    if (typeof data === 'string' && data.length > MAX_TERMINAL_WRITE_BYTES) {
      return { ok: false, error: `write exceeds ${MAX_TERMINAL_WRITE_BYTES} characters` }
    }
    return unwrap(await send('terminal.input', `terminal:${id}`, { data: String(data ?? '') }))
  })
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    // Best-effort: a resize rejected under queue backpressure would otherwise
    // surface as an unhandled promise rejection.
    void send('terminal.resize', `terminal:${id}`, { cols, rows }).catch(() => {})
  })
  ipcMain.handle('terminal:dispose', async (_e, id: string) => {
    unmarkTerminalMounted(id)
    return unwrap(await send('terminal.dispose', `terminal:${id}`))
  })
  ipcMain.handle('terminal:set-title', async (_e, id: string, title: string) => {
    if (typeof id !== 'string' || typeof title !== 'string') {
      return { ok: false, error: 'invalid terminal id or title' }
    }
    deps.terminals.setTitle(id, title)
    deps.getWindow()?.webContents.send('control:rename-widget', { id, title })
    return { ok: true }
  })
  /** The renderer reports which terminal holds keyboard focus, if any. */
  ipcMain.on('terminal:focus', (_e, focused: boolean, id?: string) => {
    setFocusedTerminal(focused && typeof id === 'string' ? id : null)
  })
}
