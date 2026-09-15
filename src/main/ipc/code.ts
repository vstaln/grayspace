import { ipcMain } from './shims.ts'
import { listAgentConversations, type AgentConversation } from '../agentSessions.ts'
import type { AgentConversation as ExposedConversation } from '../../preload/api.ts'
import type { IpcDeps } from './types.ts'

/**
 * The renderer sees its own copy of this shape (the preload bridge cannot
 * import main). Keeping the two in step is a typecheck away, instead of a
 * mismatch that only shows up as a row the panel cannot launch.
 */
type ConversationShapesAgree = AgentConversation extends ExposedConversation
  ? ExposedConversation extends AgentConversation
    ? true
    : never
  : never
const _conversationShapesAgree: ConversationShapesAgree = true
void _conversationShapesAgree

/**
 * Scanning the agent history stores touches disk, and the Code view asks on
 * every open, refresh and folder change. One short-lived result per folder is
 * enough to keep a burst of those from re-reading the same transcripts.
 */
const CONVERSATION_CACHE_MS = 3_000
const CONVERSATION_CACHE_MAX = 8
const conversationCache = new Map<string, { at: number; pending: Promise<AgentConversation[]> }>()

function cachedConversations(dir: string): Promise<AgentConversation[]> {
  const now = Date.now()
  const hit = conversationCache.get(dir)
  if (hit && now - hit.at < CONVERSATION_CACHE_MS) return hit.pending
  const pending = listAgentConversations(dir).catch(() => [] as AgentConversation[])
  conversationCache.set(dir, { at: now, pending })
  // The cache is a burst shield, not a store: never let it grow with folders.
  if (conversationCache.size > CONVERSATION_CACHE_MAX) {
    for (const [key, entry] of conversationCache) {
      if (now - entry.at >= CONVERSATION_CACHE_MS) conversationCache.delete(key)
    }
    // Expiry alone cannot bound it when every entry is still fresh; insertion
    // order makes the oldest the first to go.
    for (const key of conversationCache.keys()) {
      if (conversationCache.size <= CONVERSATION_CACHE_MAX) break
      if (key !== dir) conversationCache.delete(key)
    }
  }
  return pending
}

export function registerCodeIpc(deps: IpcDeps): void {
  ipcMain.handle('code:load', () => deps.code.load())

  ipcMain.handle('code:conversations', async (_e, dir: unknown) => {
    const folder = typeof dir === 'string' && dir.trim() ? dir : deps.getWorkspaceDir()
    if (!folder) return []
    return cachedConversations(folder)
  })

  ipcMain.handle('code:save', async (_e, snapshot: unknown) => {
    try {
      const input = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>

      if (input.activeView === 'code' || input.activeView === 'canvas') {
        deps.state.setLastActiveView(input.activeView)
      }

      const stamped = typeof input.codeWorkspaceId === 'string' ? input.codeWorkspaceId : undefined
      const activeId = deps.code.activeWorkspaceId()
      const matches = (stamped === undefined || stamped === activeId) &&
        (input.workspaceScope === undefined || input.workspaceScope === deps.code.activeWorkspaceScope())
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
      const matches = (stamped === undefined || stamped === activeId) &&
        (input.workspaceScope === undefined || input.workspaceScope === deps.code.activeWorkspaceScope())
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
