import { CANVAS_TARGET } from '../commands/canvas.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerCanvasIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('canvas:load', () => deps.canvas.load())






  ipcMain.handle('canvas:save', async (_e, snapshot) => {
    try {
      const stamped =
        snapshot && typeof snapshot === 'object' ? (snapshot as { workspaceDir?: string | null }).workspaceDir : undefined
      const current = deps.getWorkspaceDir() ?? null
      const intended = stamped === undefined ? current : stamped ?? null
      if (intended !== current) {
        console.warn(`canvas:save discarded — workspace changed ${String(intended)} → ${String(current)}`)
        return { ok: true, discarded: true }
      }
      if (snapshot && typeof snapshot === 'object' && 'widgets' in snapshot && !Array.isArray((snapshot as { widgets?: unknown }).widgets)) {
        return { error: 'invalid canvas snapshot' }
      }
      return unwrap(await send('canvas.import', CANVAS_TARGET, snapshot ?? {}))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
