export interface CustomCodeAgent {
  id: string
  name: string
  command: string
}

export const MAX_CUSTOM_CODE_AGENTS = 12
const RESERVED_IDS = new Set(['claude', 'codex', 'antigravity', 'grok', 'opencode', 'kimi', 'cursor', 'browser', 'custom'])

export function normalizeCustomCodeAgents(value: unknown): CustomCodeAgent[] {
  if (!Array.isArray(value)) return []

  const result: CustomCodeAgent[] = []
  const ids = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const agent = entry as Record<string, unknown>
    if (typeof agent.id !== 'string' || typeof agent.name !== 'string' || typeof agent.command !== 'string') continue

    const id = agent.id.trim()
    const name = agent.name.trim()
    const command = agent.command.trim()
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || RESERVED_IDS.has(id.toLowerCase()) || ids.has(id)) continue
    if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) continue
    if (!command || command.length > 512 || /[\u0000-\u001f\u007f]/.test(command)) continue

    ids.add(id)
    result.push({ id, name, command })
    if (result.length === MAX_CUSTOM_CODE_AGENTS) break
  }
  return result
}
