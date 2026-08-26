import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, send } from '../control.js'
import { AgentId, actionOf, guard, req } from '../util.js'

export const TERMINAL_TOOL_NAMES = ['terminal', 'terminal_permission']

/**
 * Real shells on the canvas. One tool, four actions — send/read are the loop
 * agents repeat most, so they take the fewest keystrokes.
 */
export function registerTerminalTools(server: McpServer): void {
  server.tool(
    'terminal',
    'Terminals = real shells the user watches live on the canvas. Actions: open | send | read | close. Typical loop: open → send → read (repeat read until the prompt/output you need). Canvas listing of all widgets: canvas{action:"list"}.',
    {
      action: z.enum(['open', 'send', 'read', 'close']).describe(
        'open = new terminal (returns id); send = type a line (Enter by default); read = recent output; close = kill the shell'
      ),
      id: z.string().optional().describe('terminal id — required for send / read / close'),
      text: z.string().optional().describe('send: the line to type'),
      pressEnter: z.boolean().optional().describe('send: press Enter after typing (default true)'),
      clear: z.boolean().optional().describe('read: clear the buffer after reading (default false)'),
      full: z.boolean().optional().describe('read: return the full retained scrollback (default false)'),
      title: z.string().optional().describe('open: window title the user sees'),
      cwd: z.string().optional().describe('open: working directory (defaults to the project folder)'),
      agentId: AgentId.optional()
    },
    (input) =>
      guard(async () => {
        const action = actionOf(input, ['open', 'send', 'read', 'close'] as const)
        switch (action) {
          case 'open': {
            return post('/widgets/terminal', {
              agentId: req(input.agentId, 'action:"open" needs your agentId'),
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {})
            })
          }
          case 'send': {
            const id = req(input.id, 'action:"send" needs id (from open or canvas list)')
            return post(`/terminal/${encodeURIComponent(id)}/write`, {
              agentId: req(input.agentId, 'action:"send" needs your agentId'),
              text: req(input.text, 'action:"send" needs text'),
              ...(input.pressEnter !== undefined ? { pressEnter: input.pressEnter } : {})
            })
          }
          case 'read': {
            const id = req(input.id, 'action:"read" needs id (from open or canvas list)')
            const params = new URLSearchParams()
            if (input.clear) params.set('clear', '1')
            if (input.full) params.set('full', '1')
            const qs = params.toString() ? `?${params.toString()}` : ''
            const data = await controlApi<{ output: string }>(
              `/terminal/${encodeURIComponent(id)}/output${qs}`
            )
            return data.output
          }
          case 'close': {
            const id = req(input.id, 'action:"close" needs id')
            return send(`/widgets/${encodeURIComponent(id)}`, 'DELETE', {
              agentId: req(input.agentId, 'action:"close" needs your agentId')
            })
          }
        }
      })
  )

  server.tool(
    'terminal_permission',
    'Confirms a permission prompt currently visible in a Claude Code terminal. Use allow for this request, always to choose “allow always”, or deny. The tool sends the selection and Enter as separate keystrokes so Claude receives it as a real confirmation, not pasted text.',
    {
      id: z.string().describe('Terminal id from terminal{action:"open"} or canvas{action:"list"}'),
      choice: z.enum(['allow', 'always', 'deny']).default('allow').describe('allow = once; always = allow always; deny = reject'),
      agentId: AgentId
    },
    (input) =>
      guard(async () => {
        const id = req(input.id, 'terminal_permission needs id')
        const agentId = req(input.agentId, 'terminal_permission needs agentId')
        // Claude Code renders this as an interactive select menu. Reset to the
        // first item, then move to the requested option; sending the visible
        // number is not reliable because Ink treats it as ordinary input.
        const moves = input.choice === 'always' ? 1 : input.choice === 'deny' ? 2 : 0
        const selection = '\u001b[A'.repeat(3) + '\u001b[B'.repeat(moves)
        return post(`/terminal/${encodeURIComponent(id)}/write`, {
          agentId,
          text: selection,
          pressEnter: true
        })
      })
  )
}
