import { ipcMain } from './shims.ts'
import type { IpcDeps } from './types.ts'

export function registerCodeIpc(deps: IpcDeps): void {
  ipcMain.handle('code:load', () => deps.code.load())

  ipcMain.handle('code:save', async (_e, snapshot: unknown) => {
    try {
      const input = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>
      // Stale-workspace guard like canvas:save — prevent an old debounced save
      // from a previous workspace overwriting the newly switched one.
      const stamped = typeof input.workspaceDir === 'string' ? input.workspaceDir : input.workspaceDir === null ? null : undefined
      const current = deps.getWorkspaceDir() ?? null
      const intended = stamped === undefined ? current : stamped ?? null
      if (intended !== current) return { ok: true }
      // Remove the helper key before handing to store
      const { workspaceDir: _ws, ...rest } = input
      const result = deps.code.save(rest as { sessions?: unknown; featuredId?: unknown; maximizedId?: unknown; activeView?: unknown })
      return { ok: true, snapshot: result }
    } catch (err) {
      return { error: String((err as Error)?.message ?? err) }
    }
  })
}
