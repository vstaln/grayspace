import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, text } from '../control.js'

export const TERMINAL_TOOL_NAMES = ['list_terminals', 'create_terminal', 'send_text', 'read_output', 'close_terminal']

/** Terminals and note widgets on the OrcSpace canvas. */
export function registerTerminalTools(server: McpServer): void {
  server.tool(
    'list_terminals',
    'Виджеты на холсте OrcSpace: терминалы (id, заголовок, рабочая папка) и заметки (id, заголовок).',
    {},
    async () => text(await controlApi<{ widgets: unknown[] }>('/widgets'))
  )

  server.tool(
    'create_terminal',
    'Открывает новый терминал на холсте OrcSpace и возвращает его id. Пользователь видит это окно и всё, что в нём происходит.',
    {
      title: z.string().optional().describe('Заголовок окна терминала'),
      cwd: z.string().optional().describe('Рабочая папка; по умолчанию — папка воркспейса'),
      // All control-API mutations are journaled under an actor.  This must be
      // required in the MCP schema too: otherwise the client omits it and the
      // backend rejects the call with the much less useful "agentId is required".
      agentId: z.string().min(1).describe('Stable ID of this agent')
    },
    async (input) => text(await post('/widgets/terminal', input))
  )

  server.tool(
    'send_text',
    'Печатает текст в терминал, как если бы пользователь ввёл его с клавиатуры.',
    {
      id: z.string().describe('id терминала из create_terminal или list_terminals'),
      text: z.string().describe('Текст для ввода'),
      pressEnter: z.boolean().optional().describe('Нажать Enter после текста (по умолчанию true)'),
      agentId: z.string().min(1).describe('Stable ID of this agent')
    },
    async ({ id, ...body }) => text(await post(`/terminal/${encodeURIComponent(id)}/write`, body))
  )

  server.tool(
    'read_output',
    'Читает недавний вывод терминала.',
    {
      id: z.string().describe('id терминала'),
      clear: z.boolean().optional().describe('Очистить буфер после чтения (по умолчанию false)')
    },
    async ({ id, clear }) => {
      const data = await controlApi<{ output: string }>(
        `/terminal/${encodeURIComponent(id)}/output${clear ? '?clear=1' : ''}`
      )
      return text(data.output)
    }
  )

  server.tool(
    'close_terminal',
    'Закрывает терминал и завершает его процесс.',
    {
      id: z.string().describe('id терминала'),
      agentId: z.string().min(1).describe('Stable ID of this agent')
    },
    async ({ id, agentId }) =>
      text(
        await controlApi(`/widgets/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId })
        })
      )
  )
}
