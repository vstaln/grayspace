import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, send } from '../control.js'
import { AgentId, actionOf, guard, req } from '../util.js'

export const PLANNER_TOOL_NAMES = ['plan']

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/

interface PlanRow {
  id?: string
  title?: string
  note?: string
  project?: string
  day?: string
  time?: string
  done?: boolean
  order?: number
  version?: number
}

function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftLocalDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return localDayKey(date)
}

/**
 * The user's day checklist — checkbox lines with optional day/time/project.
 * NOT the kanban board; board work goes through `board`.
 */
export function registerPlannerTools(server: McpServer): void {
  server.tool(
    'plan',
    "The user's day planner (checkbox outline in the planner widget). Actions: list | create | update | toggle | delete. list first — it shows current checkmarks and gives you itemIds. day YYYY-MM-DD (omit = undated inbox), time HH:MM, project = group label.",
    {
      action: z.enum(['list', 'create', 'update', 'toggle', 'delete']).describe(
        'list = items + counts (scope/project filters); create/toggle/delete are self-explanatory; update edits any field'
      ),
      scope: z
        .enum(['all', 'today', 'week', 'inbox', 'open', 'done'])
        .optional()
        .describe('list: all (default) | today | week (next 7 days) | inbox (no day) | open | done'),
      project: z.string().optional().describe('list/create/update: project group label'),
      itemId: z.string().optional().describe('update / toggle / delete: id from list'),
      title: z.string().optional().describe('create/update: the checkbox line text'),
      note: z.string().optional().describe('create/update: longer note under the line'),
      day: z.string().regex(DAY).optional().describe('create: day YYYY-MM-DD; update: same, null clears'),
      time: z.string().regex(TIME).optional().describe('create: HH:MM; update: same, null clears'),
      done: z.boolean().optional().describe('toggle: true=done, false=reopen, omit=flip; update: set directly'),
      order: z.number().optional().describe('update: manual sort position'),
      baseVersion: z.number().optional().describe('update: version from list — prevents racing the user'),
      agentId: AgentId.optional()
    },
    (input) =>
      guard(async () => {
        const action = actionOf(input, ['list', 'create', 'update', 'toggle', 'delete'] as const)
        switch (action) {
          case 'list': {
            const raw = await controlApi<{ items?: PlanRow[]; summary?: Record<string, unknown> }>('/planner')
            let items = Array.isArray(raw.items) ? raw.items : []
            const today = localDayKey()
            const weekEnd = shiftLocalDay(today, 6)
            if (input.scope === 'today') items = items.filter((i) => i.day === today)
            else if (input.scope === 'week')
              items = items.filter((i) => typeof i.day === 'string' && i.day >= today && i.day <= weekEnd)
            else if (input.scope === 'inbox') items = items.filter((i) => !i.day)
            else if (input.scope === 'open') items = items.filter((i) => !i.done)
            else if (input.scope === 'done') items = items.filter((i) => i.done === true)
            if (input.project?.trim()) {
              const p = input.project.trim().toLowerCase()
              items = items.filter((i) => (i.project ?? '').toLowerCase() === p)
            }
            return {
              summary: raw.summary ?? null,
              count: items.length,
              items
            }
          }
          case 'create': {
            return post('/planner', {
              agentId: req(input.agentId, 'action:"create" needs your agentId'),
              title: req(input.title, 'action:"create" needs title'),
              ...(input.note !== undefined ? { note: input.note } : {}),
              ...(input.project !== undefined ? { project: input.project } : {}),
              ...(input.day !== undefined ? { day: input.day } : {}),
              ...(input.time !== undefined ? { time: input.time } : {})
            })
          }
          case 'update': {
            const itemId = req(input.itemId, 'action:"update" needs itemId (from list)')
            return send(`/planner/${encodeURIComponent(itemId)}`, 'PATCH', {
              agentId: req(input.agentId, 'action:"update" needs your agentId'),
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.note !== undefined ? { note: input.note } : {}),
              ...(input.project !== undefined ? { project: input.project } : {}),
              ...(input.day !== undefined ? { day: input.day } : {}),
              ...(input.time !== undefined ? { time: input.time } : {}),
              ...(input.done !== undefined ? { done: input.done } : {}),
              ...(input.order !== undefined ? { order: input.order } : {}),
              ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {})
            })
          }
          case 'toggle': {
            const itemId = req(input.itemId, 'action:"toggle" needs itemId (from list)')
            return post(`/planner/${encodeURIComponent(itemId)}/toggle`, {
              agentId: req(input.agentId, 'action:"toggle" needs your agentId'),
              ...(input.done !== undefined ? { done: input.done } : {})
            })
          }
          case 'delete': {
            const itemId = req(input.itemId, 'action:"delete" needs itemId (from list)')
            return send(`/planner/${encodeURIComponent(itemId)}`, 'DELETE', {
              agentId: req(input.agentId, 'action:"delete" needs your agentId')
            })
          }
        }
      })
  )
}
