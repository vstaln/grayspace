import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, text } from '../control.js'

export const WIDGET_TOOL_NAMES = [
  'list_widgets',
  'rename_widget',
  'move_widget',
  'place_widget',
  'close_widget',
  'focus_camera',
  'list_locks',
  'lock_resource',
  'unlock_resource',
  'keep_locks_alive',
  'read_journal',
  'git_status',
  'git_commit',
  'delete_brain_note'
]

/** DELETE/PATCH with a JSON body — `controlApi` only wraps GET and POST. */
function send(path: string, method: 'PATCH' | 'DELETE', body: unknown): Promise<unknown> {
  return controlApi(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/**
 * What a manager agent needs beyond opening terminals: seeing the canvas as
 * the user sees it, arranging it, reserving resources before touching them,
 * and reading back what everyone else has done.
 *
 * Two ideas run through all of it. Every write goes through the app's command
 * bus, so an agent gets the same conflict and lock answers the user's own UI
 * would. And every write is journaled under this agent's id, so `read_journal`
 * is a real account of who changed what rather than a guess.
 */
export function registerWidgetTools(server: McpServer): void {
  // ---- the canvas ---------------------------------------------------------

  server.tool(
    'list_widgets',
    'Всё, что сейчас на холсте: терминалы, заметки, git-виджеты, таймеры — с их id, типом и ЗАГОЛОВКОМ, который видит пользователь. Если пользователь переименовал «Terminal 1» во что-то своё, здесь будет его название. Вызывайте это перед тем, как ссылаться на окно в разговоре.',
    {},
    async () => text(await controlApi<{ widgets: unknown[] }>('/widgets'))
  )

  server.tool(
    'rename_widget',
    'Переименовывает виджет — так же, как пользователь двойным щелчком по заголовку. Название видно пользователю, поэтому оно должно описывать содержимое («сборка», «тесты»), а не быть служебным идентификатором.',
    {
      id: z.string().describe('id виджета из list_widgets'),
      title: z.string().min(1).max(120).describe('Новый заголовок'),
      agentId: z.string().min(1).describe('ID этого агента'),
      baseVersion: z
        .number()
        .optional()
        .describe('version виджета из list_widgets: защищает от перезаписи чужой правки')
    },
    async ({ id, ...body }) => text(await send(`/widgets/${encodeURIComponent(id)}`, 'PATCH', body))
  )

  server.tool(
    'move_widget',
    'Двигает или меняет размер виджета на холсте. Координаты — мировые, те же, что видит пользователь; сворачивание доступно через minimized.',
    {
      id: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().optional().describe('Ширина в пикселях холста'),
      h: z.number().optional().describe('Высота в пикселях холста'),
      minimized: z.boolean().optional(),
      agentId: z.string().min(1),
      baseVersion: z.number().optional()
    },
    async ({ id, ...body }) => text(await send(`/widgets/${encodeURIComponent(id)}`, 'PATCH', body))
  )

  server.tool(
    'place_widget',
    'Ставит на холст виджет, которому не нужен процесс: git-статус, таймер, запланированные задачи (с доски), планер (личный outline на день) или доску задач. Терминал открывается отдельным инструментом create_terminal. Планер ≠ schedule: schedule — задачи со сроком с kanban, planner — отдельный day plan.',
    {
      kind: z
        .enum(['git-status', 'timer', 'schedule', 'planner', 'board'])
        .describe('Тип виджета: planner — day plan, schedule — due tasks с доски'),
      title: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      agentId: z.string().min(1)
    },
    async (input) => text(await post('/widgets', input))
  )

  server.tool(
    'close_widget',
    'Закрывает любой виджет: терминал (с завершением процесса), заметку на холсте, git-виджет. Заметка при этом остаётся во «Втором мозге» — с холста убирается только окно.',
    { id: z.string(), agentId: z.string().min(1) },
    async ({ id, agentId }) => text(await send(`/widgets/${encodeURIComponent(id)}`, 'DELETE', { agentId }))
  )

  server.tool(
    'focus_camera',
    'Перемещает камеру холста — чтобы показать пользователю то, о чём идёт речь. zoom: 1 — обычный масштаб, меньше единицы — отдалить.',
    {
      x: z.number().describe('Смещение камеры по X'),
      y: z.number().describe('Смещение камеры по Y'),
      zoom: z.number().min(0.2).max(4).describe('Масштаб, 0.2–4'),
      agentId: z.string().min(1)
    },
    async (input) => text(await post('/canvas/camera', input))
  )

  // ---- resource locks -----------------------------------------------------

  server.tool(
    'list_locks',
    'Занятые сейчас ресурсы: файлы, заметки, терминалы, репозиторий — кто держит и до какого времени. Проверяйте перед тем, как раздавать работу: занятый ресурс означает, что там уже кто-то работает.',
    {},
    async () => text(await controlApi('/locks'))
  )

  server.tool(
    'lock_resource',
    'Резервирует ресурс за собой до того, как его менять. Адрес вида scheme:id — «file:src/main/index.ts», «note:note-17», «terminal:term-3», «git:repo». Блокировка живёт с TTL и продлевается keep_locks_alive; если агент умолк, она освободится сама.',
    {
      resource: z.string().describe('scheme:id, например file:src/main/index.ts'),
      agentId: z.string().min(1),
      ttlMs: z.number().optional().describe('Время жизни в мс (по умолчанию 30 сек, максимум 10 мин)'),
      reason: z.string().optional().describe('Зачем взят — видно пользователю и попадает в журнал')
    },
    async (input) => text(await post('/locks', input))
  )

  server.tool(
    'unlock_resource',
    'Освобождает ресурс. Отпускайте сразу, как закончили: чужая работа стоит в очереди за вашей блокировкой.',
    { resource: z.string(), agentId: z.string().min(1) },
    async ({ resource, agentId }) => text(await send(`/locks/${encodeURIComponent(resource)}`, 'DELETE', { agentId }))
  )

  server.tool(
    'keep_locks_alive',
    'Продлевает все блокировки этого агента одним вызовом. Нужен в длинной работе: молчание дольше TTL считается смертью агента, и его ресурсы отдают другим.',
    { agentId: z.string().min(1) },
    async (input) => text(await post('/locks/heartbeat', input))
  )

  // ---- history ------------------------------------------------------------

  server.tool(
    'read_journal',
    'Журнал команд: кто и что менял, по порядку — правки пользователя, других агентов и встроенного ассистента. Полезно, чтобы понять, что изменилось, пока вы работали, и не переспрашивать пользователя.',
    { since: z.number().optional().describe('Читать записи после этого seq; 0 — с начала окна журнала') },
    async ({ since }) => text(await controlApi(`/journal?since=${since ?? 0}`))
  )

  // ---- git ----------------------------------------------------------------

  server.tool(
    'git_status',
    'Состояние репозитория в папке проекта: ветка, сколько файлов изменено и не отслеживается, отставание/опережение от remote, последний коммит. Читается запуском git, а не разбором вывода терминала.',
    {},
    async () => text(await controlApi('/git/status'))
  )

  server.tool(
    'git_commit',
    'Добавляет все изменения и делает коммит. Требует блокировку git:repo — возьмите её через lock_resource, иначе второй агент закоммитит поверх наполовину готового дерева. Сообщение пишите по-человечески: его увидит пользователь в истории.',
    { message: z.string().min(1).describe('Сообщение коммита'), agentId: z.string().min(1) },
    async (input) => text(await post('/git/commit', input))
  )

  // ---- notes --------------------------------------------------------------

  server.tool(
    'delete_brain_note',
    'Убирает заметку из «Второго мозга» в корзину. Это мягкое удаление — пользователь может её вернуть, — но всё равно спрашивайте, прежде чем удалять то, что писал он.',
    { id: z.string(), agentId: z.string().min(1) },
    async ({ id, agentId }) => text(await send(`/brain/${encodeURIComponent(id)}`, 'DELETE', { agentId }))
  )
}
