import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, text } from '../control.js'

export const PLANNER_TOOL_NAMES = [
  'list_plan_items',
  'create_plan_item',
  'update_plan_item',
  'delete_plan_item'
]

/** PATCH/DELETE with a JSON body — same helper pattern as widget tools. */
function send(path: string, method: 'PATCH' | 'DELETE', body: unknown): Promise<unknown> {
  return controlApi(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/**
 * The personal day planner — not the kanban board and not "scheduled tasks".
 *
 * A plan item is a line on the human's outline for a day (optional time, done
 * flag, hand order). A manager agent uses these tools to help fill or adjust
 * that outline; placing the planner widget itself is `place_widget` with
 * kind `planner`.
 */
export function registerPlannerTools(server: McpServer): void {
  server.tool(
    'list_plan_items',
    'Читает планер: плоский список пунктов плана (не задачи с доски). У каждого может быть день (YYYY-MM-DD), время (HH:MM) и флаг done. Это личный outline руководителя/пользователя, а не делегируемая работа.',
    {},
    async () => text(await controlApi('/planner'))
  )

  server.tool(
    'create_plan_item',
    'Добавляет пункт в планер. Не создаёт задачу на kanban-доске — только строку outline. day: YYYY-MM-DD (без дня — в «без даты»), time: HH:MM по желанию.',
    {
      agentId: z.string().min(1).describe('ID этого агента'),
      title: z.string().min(1).describe('Текст пункта плана'),
      note: z.string().optional().describe('Заметка к пункту'),
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('День YYYY-MM-DD'),
      time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
        .describe('Время HH:MM')
    },
    async (input) => text(await post('/planner', input))
  )

  server.tool(
    'update_plan_item',
    'Меняет пункт планера: заголовок, заметку, день/время, done, order. Чтобы снять день или время, передайте day: null или time: null. baseVersion из list_plan_items защищает от гонок.',
    {
      itemId: z.string().describe('id пункта из list_plan_items'),
      agentId: z.string().min(1),
      title: z.string().min(1).optional(),
      note: z.string().optional(),
      day: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
      time: z.union([z.string().regex(/^\d{2}:\d{2}$/), z.null()]).optional(),
      done: z.boolean().optional(),
      order: z.number().optional(),
      baseVersion: z.number().optional()
    },
    async ({ itemId, ...body }) =>
      text(await send(`/planner/${encodeURIComponent(itemId)}`, 'PATCH', body))
  )

  server.tool(
    'delete_plan_item',
    'Удаляет пункт из планера. Не трогает задачи на доске.',
    {
      itemId: z.string(),
      agentId: z.string().min(1)
    },
    async ({ itemId, agentId }) =>
      text(await send(`/planner/${encodeURIComponent(itemId)}`, 'DELETE', { agentId }))
  )
}
