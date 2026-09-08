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






export function registerTerminalIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('terminal:create', async (_e, id: string, cols?: number, rows?: number) => {




    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) {
      return { ok: false, error: 'terminal id is required' }
    }
    markTerminalMounted(id)
    try {
      const result = unwrap(await send<{ ok: boolean; error?: string }>('terminal.spawn', `terminal:${id}`, { cols, rows }))



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




    if (!(result && typeof result === 'object' && 'error' in result)) unmarkTerminalMounted(id)
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

  ipcMain.on('terminal:focus', (_e, focused: boolean, id?: string) => {
    setFocusedTerminal(focused && typeof id === 'string' && TERMINAL_ID.test(id) ? id : null)
  })
}
