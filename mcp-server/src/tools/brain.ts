import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, text } from '../control.js'

export const BRAIN_TOOL_NAMES = ['list_brain_notes', 'search_brain', 'save_brain_note', 'update_brain_note']

/** Second Brain: the user's durable notes, searchable and linkable by the agent. */
export function registerBrainTools(server: McpServer): void {
  server.tool('list_brain_notes', 'Reads the user\'s Second Brain notes: titles, content, tags and attached project context.', {}, async () => text(await controlApi('/brain')))

  server.tool('search_brain', 'Searches the user\'s Second Brain. Use it before asking for context the user may already have saved.', { query: z.string().describe('Words to search in titles, content, and tags') }, async ({ query }) => text(await controlApi(`/brain/search?q=${encodeURIComponent(query)}`)))

  server.tool('save_brain_note', 'Saves a durable note into the user\'s Second Brain. Link another note by writing $Exact title; shared tags also create graph connections.', { title: z.string().min(1), content: z.string().optional(), tags: z.array(z.string()).optional(), projectDir: z.string().optional() }, async (input) => text(await post('/brain', input)))

  server.tool('update_brain_note', 'Updates an existing Second Brain note by id.', { id: z.string(), title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional(), projectDir: z.string().optional() }, async ({ id, ...body }) => text(await controlApi(`/brain/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })))
}
