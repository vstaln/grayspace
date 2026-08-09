import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, text } from '../control.js'

export const COORDINATION_TOOL_NAMES = [
  'claim_manager_role',
  'coordination_status',
  'list_board_tasks',
  'create_delegated_task',
  'claim_delegated_task',
  'update_delegated_task',
  'lock_task_file'
]

/** The manager role, the task board, and the file-lock reservations that keep concurrent agents from colliding. */
export function registerCoordinationTools(server: McpServer): void {
  server.tool(
    'claim_manager_role',
    'Забирает единственную роль руководителя. Только руководитель раздаёт работу; второй претендент получит отказ. Пользователь может сбросить роль кнопкой в приложении.',
    { agentId: z.string().min(1).describe('Устойчивый идентификатор этого агента') },
    async (input) => text(await post('/coordination/manager', input))
  )

  server.tool(
    'coordination_status',
    'Показывает руководителя, доску задач (включая задачи, добавленные пользователем) и активные блокировки файлов.',
    {},
    async () => text(await controlApi('/coordination/status'))
  )

  server.tool(
    'list_board_tasks',
    'Читает доску задач. Задачи с createdBy="user" поставил человек — их следует брать в работу в первую очередь.',
    {},
    async () => text(await controlApi('/coordination/tasks'))
  )

  server.tool(
    'create_delegated_task',
    'Только для руководителя: создаёт узко очерченную задачу для одного исполнителя. Передавайте лишь необходимый контекст и непересекающиеся файлы — при захвате все перечисленные файлы блокируются автоматически, и задача с пересекающимся списком не сможет быть взята, пока файлы не освободятся.',
    {
      agentId: z.string(),
      title: z.string().min(1),
      brief: z.string().optional(),
      files: z.array(z.string()).optional(),
      maxSteps: z.number().int().min(1).max(100).optional(),
      maxReviewIterations: z.number().int().min(1).max(10).optional()
    },
    async (input) => text(await post('/coordination/tasks', input))
  )

  server.tool(
    'claim_delegated_task',
    'Только для исполнителя: берёт одну задачу из очереди и автоматически блокирует все её файлы. Если хотя бы один файл уже заблокирован другой активной задачей — захват отклоняется целиком (409), задача остаётся в очереди. Не начинайте правки до успешного захвата.',
    { taskId: z.string(), agentId: z.string().min(1) },
    async ({ taskId, agentId }) =>
      text(await post(`/coordination/tasks/${encodeURIComponent(taskId)}/claim`, { agentId }))
  )

  server.tool(
    'update_delegated_task',
    'Переводит задачу в работу, на проверку, в готово или отменяет её. Доступно руководителю и назначенному исполнителю.',
    {
      taskId: z.string(),
      agentId: z.string(),
      state: z.enum(['backlog', 'queued', 'in_progress', 'review', 'done', 'cancelled'])
    },
    async ({ taskId, ...body }) =>
      text(
        await controlApi(`/coordination/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
      )
  )

  server.tool(
    'lock_task_file',
    'Блокирует ДОПОЛНИТЕЛЬНЫЙ файл (не указанный при создании задачи) за назначенным исполнителем. Файлы из списка задачи блокируются автоматически при claim_delegated_task — этот инструмент нужен только для файлов, о которых стало известно уже в процессе работы. Каждое обновление статуса задачи (update_delegated_task) продлевает блокировку; она истекает сама только если задача брошена без единого обновления.',
    {
      taskId: z.string(),
      agentId: z.string(),
      path: z.string(),
      ttlMs: z.number().int().min(60000).max(3600000).optional()
    },
    async (input) => text(await post('/coordination/locks', input))
  )
}
