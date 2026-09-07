import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'

export function registerCodeIpc(deps: IpcDeps): void {
  ipcMain.handle('code:load', () => deps.code.load())

  ipcMain.handle('code:save', async (_e, snapshot: unknown) => {
    try {
      const input = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>
      // Stale-workspace guard: a delayed save from another Code Workspace must
      // never overwrite the workspace selected since that save was scheduled.
      const stamped = typeof input.codeWorkspaceId === 'string' ? input.codeWorkspaceId : undefined
      if (stamped !== undefined && stamped !== deps.code.activeWorkspaceId()) return { ok: true }
      // Remove the helper key before handing to store
      const { workspaceDir: _legacyWorkspaceDir, codeWorkspaceId: _codeWorkspaceId, ...rest } = input
      const result = deps.code.save(rest as { sessions?: unknown; featuredId?: unknown; maximizedId?: unknown; activeView?: unknown })
      return { ok: true, snapshot: result }
    } catch (err) {
      return { error: String((err as Error)?.message ?? err) }
    }
  })
}
