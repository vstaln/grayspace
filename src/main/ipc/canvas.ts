import { CANVAS_TARGET } from '../commands/canvas.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerCanvasIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)

  ipcMain.handle('canvas:load', () => deps.canvas.load())
  /**
   * The renderer owns the live layout while the user drags, and echoes it back
   * here periodically. `canvas.import` merges rather than replaces, so a
   * widget an agent created or moved in the meantime is not undone by a save
   * describing the canvas as the window last saw it.
   */
  ipcMain.handle('canvas:save', async (_e, snapshot) => {
    const stamped =
      snapshot && typeof snapshot === 'object' ? (snapshot as { workspaceDir?: string | null }).workspaceDir : undefined
    const current = deps.getWorkspaceDir() ?? null
    const intended = stamped === undefined ? current : stamped ?? null
    if (intended !== current) return { ok: true }
    return unwrap(await send('canvas.import', CANVAS_TARGET, snapshot ?? {}))
  })
}
