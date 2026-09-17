import { CANVAS_TARGET } from '../commands/canvas.ts'
import { CanvasDeltaStream } from '../canvasDelta.ts'
import { resourceId } from '../core/resources.ts'
import { ipcMain } from './shims.ts'
import { makeSend, unwrap } from './shared.ts'
import type { IpcDeps } from './types.ts'

export function registerCanvasIpc(deps: IpcDeps): void {
  const send = makeSend(deps.core)
  const deltaStream = new CanvasDeltaStream({
    journal: deps.core.journal,
    snapshot: () => deps.canvas.snapshot(),
    workspaceDir: deps.getWorkspaceDir
  })
  deltaStream.on('delta', (delta) => {
    try {
      const window = deps.getWindow()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('canvas:onDelta', delta)
      }
    } catch (err) {
      console.warn('failed to send canvas delta', err)
    }
  })

  ipcMain.handle('canvas:load', () => deps.canvas.load())

  ipcMain.handle('canvas:replay', (_e, since?: unknown) => {
    const cursor = typeof since === 'number' ? since : 0
    return deltaStream.replay(cursor)
  })

  ipcMain.handle('canvas:update-widget', async (_e, id: unknown, patch: unknown, baseVersion?: unknown) => {
    if (typeof id !== 'string' || id.length === 0) return { error: 'invalid widget id' }
    const version = typeof baseVersion === 'number' ? baseVersion : undefined
    return unwrap(await send('widget.update', resourceId('widget', id), patch ?? {}, version))
  })






  ipcMain.handle('canvas:save', async (_e, snapshot) => {
    try {
      const stamped =
        snapshot && typeof snapshot === 'object' ? (snapshot as { workspaceDir?: string | null }).workspaceDir : undefined
      const current = deps.getWorkspaceDir() ?? null
      const intended = stamped === undefined ? current : stamped ?? null
      if (intended !== current) {
        deps.canvas.persistSnapshotForWorkspace(intended ?? undefined, snapshot)
        return { ok: true, historical: true }
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
