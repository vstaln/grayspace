import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi } from '../control.js'
import { guard, truncate } from '../util.js'

export const JOURNAL_TOOL_NAMES = ['read_journal']

interface JournalEntry {
  seq?: number
  at?: number
  phase?: string
  actorId?: string
  type?: string
  target?: string
  error?: string
}

/** Keep answers bounded: the tail is what "what moved while I worked" needs. */
const MAX_ENTRIES = 60

export function registerJournalTools(server: McpServer): void {
  server.tool(
    'read_journal',
    'The command journal: who changed what, in order — the user, other agents, the assistant. Read this instead of re-asking the user what happened.',
    {
      since: z.number().optional().describe('entries after this seq (default: last 60); 0 = start of the window')
    },
    ({ since }) =>
      guard(async () => {
        const data = await controlApi<{ lastSeq?: number; entries?: JournalEntry[] }>(
          `/journal?since=${since ?? 0}`
        )
        const entries = data.entries ?? []
        const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
        return {
          lastSeq: data.lastSeq,
          shown: trimmed.length,
          truncated: entries.length > trimmed.length,
          entries: trimmed.map((e) => ({
            seq: e.seq,
            actorId: e.actorId,
            type: e.type,
            target: e.target,
            ...(e.error ? { error: truncate(e.error, 160) } : {})
          }))
        }
      })
  )
}
