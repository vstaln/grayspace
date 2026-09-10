import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'

export function registerCodeIpc(deps: IpcDeps): void {
  ipcMain.handle('code:load', () => deps.code.load())

  ipcMain.handle('code:save', async (_e, snapshot: unknown) => {
    try {
      const input = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>

      if (input.activeView === 'code' || input.activeView === 'canvas') {
        deps.state.setLastActiveView(input.activeView)
      }

      const stamped = typeof input.codeWorkspaceId === 'string' ? input.codeWorkspaceId : undefined
      const activeId = deps.code.activeWorkspaceId()
      const matches = stamped === undefined || stamped === activeId
      if (!matches) return { ok: true, discarded: true }

      const { workspaceDir: _legacyWorkspaceDir, codeWorkspaceId: _codeWorkspaceId, ...rest } = input
      const result = deps.code.save(rest as { sessions?: unknown; featuredId?: unknown; maximizedId?: unknown; activeView?: unknown }, false)
      return { ok: true, snapshot: result }
    } catch (err) {
      return { error: String((err as Error)?.message ?? err) }
    }
  })

  ipcMain.on('code:save-sync', (event, snapshot: unknown) => {
    try {
      const input = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>
      if (input.activeView === 'code' || input.activeView === 'canvas') {
        deps.state.setLastActiveView(input.activeView)
      }
      const stamped = typeof input.codeWorkspaceId === 'string' ? input.codeWorkspaceId : undefined
      const activeId = deps.code.activeWorkspaceId()
      const matches = stamped === undefined || stamped === activeId
      if (matches) {
        const { workspaceDir: _legacyWorkspaceDir, codeWorkspaceId: _codeWorkspaceId, ...rest } = input
        deps.code.save(rest as { sessions?: unknown; featuredId?: unknown; maximizedId?: unknown; activeView?: unknown }, true)
      }
      deps.code.flush()
      event.returnValue = { ok: true }
    } catch (err) {
      deps.code.flush()
      event.returnValue = { error: String((err as Error)?.message ?? err) }
    }
  })
}
