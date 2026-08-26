import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, send } from '../control.js'
import { AgentId, actionOf, guard, req, truncate, ToolInputError } from '../util.js'

export const BRAIN_TOOL_NAMES = ['brain']

interface BrainNoteRow {
  id?: string
  title?: string
  body?: string
  content?: string
  tags?: string[]
  projectDir?: string
  updatedAt?: number
}

/** List/search answers stay small: preview instead of full bodies. */
function compact(note: BrainNoteRow): Record<string, unknown> {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags ?? [],
    projectDir: note.projectDir,
    preview: truncate(String(note.body ?? note.content ?? ''), 240)
  }
}

/**
 * Second Brain — the user's durable, searchable notes. One tool, six actions.
 */
export function registerBrainTools(server: McpServer): void {
  server.tool(
    'brain',
    "The user's Second Brain: durable notes that survive sessions. Actions: list | read | search | save | update | delete. Link notes by writing $Exact title inside a body; shared tags connect them too.",
    {
      action: z.enum(['list', 'read', 'search', 'save', 'update', 'delete']).describe(
        'list = all notes (compact); read = one full note by id; search = filter by words; save/update/delete = write (agentId required)'
      ),
      id: z.string().optional().describe('note id — required for read / update / delete'),
      query: z.string().optional().describe('search: words to match in titles, bodies and tags'),
      title: z.string().optional().describe('save/update: note title'),
      content: z.string().optional().describe('save/update: markdown body; $ExactTitle links another note'),
      tags: z.array(z.string()).optional().describe('save/update: shared tags wire notes into the graph'),
      projectDir: z.string().optional().describe('save/update: folder this note belongs to'),
      baseVersion: z.number().optional().describe('update: version from list/read — prevents clobbering a newer edit'),
      agentId: AgentId.optional()
    },
    (input) =>
      guard(async () => {
        const action = actionOf(input, ['list', 'read', 'search', 'save', 'update', 'delete'] as const)
        switch (action) {
          case 'list': {
            const data = await controlApi<{ notes?: BrainNoteRow[] }>('/brain')
            const notes = data.notes ?? []
            return { count: notes.length, notes: notes.map(compact) }
          }
          case 'search': {
            const q = req(input.query, 'action:"search" needs query')
            const data = await controlApi<{ notes?: BrainNoteRow[] }>(
              `/brain/search?q=${encodeURIComponent(q)}`
            )
            const notes = data.notes ?? []
            return { count: notes.length, notes: notes.map(compact) }
          }
          case 'read': {
            const id = req(input.id, 'action:"read" needs id (from list/search)')
            const data = await controlApi<{ notes?: BrainNoteRow[] }>('/brain')
            const note = (data.notes ?? []).find((n) => n.id === id)
            if (!note) throw new ToolInputError(`no note with id "${id}" — call brain{action:"list"} first`)
            return note
          }
          case 'save': {
            return post('/brain', {
              agentId: req(input.agentId, 'action:"save" needs your agentId'),
              title: req(input.title, 'action:"save" needs title'),
              ...(input.content !== undefined ? { content: input.content } : {}),
              ...(input.tags ? { tags: input.tags } : {}),
              ...(input.projectDir !== undefined ? { projectDir: input.projectDir } : {})
            })
          }
          case 'update': {
            const id = req(input.id, 'action:"update" needs id (from list/read)')
            return send(`/brain/${encodeURIComponent(id)}`, 'PATCH', {
              agentId: req(input.agentId, 'action:"update" needs your agentId'),
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.content !== undefined ? { content: input.content } : {}),
              ...(input.tags ? { tags: input.tags } : {}),
              ...(input.projectDir !== undefined ? { projectDir: input.projectDir } : {}),
              ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {})
            })
          }
          case 'delete': {
            const id = req(input.id, 'action:"delete" needs id (from list)')
            return send(`/brain/${encodeURIComponent(id)}`, 'DELETE', {
              agentId: req(input.agentId, 'action:"delete" needs your agentId')
            })
          }
        }
      })
  )
}
