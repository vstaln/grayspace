import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, send } from '../control.js'
import { AgentId, actionOf, guard, req } from '../util.js'

export const CANVAS_TOOL_NAMES = ['canvas']

/**
 * The infinite canvas the user watches: widgets and camera. Terminals are
 * opened through `terminal`, not here.
 */
export function registerCanvasTools(server: McpServer): void {
  server.tool(
    'canvas',
    'The canvas the user sees: every widget with id, kind and its visible TITLE. Actions: list | place | rename | move | focus | close. place puts a widget (timer, planner, board, files, sys-monitor, browser, links, music-player, id-generator); terminals come from terminal{action:"open"}; notes are brain notes shown as windows. focus pans the camera so the user sees what you mean.',
    {
      action: z.enum(['list', 'place', 'rename', 'move', 'focus', 'close']).describe(
        'list = everything on canvas; place/rename/move/close = arrange widgets; focus = point the camera at x,y'
      ),
      id: z.string().optional().describe('widget id — required for rename / move / close'),
      kind: z
        .enum(['timer', 'planner', 'board', 'files', 'sys-monitor', 'browser', 'links', 'music-player', 'id-generator'])
        .optional()
        .describe('place: widget kind'),
      title: z.string().optional().describe('place: initial title; rename: new user-visible title'),
      x: z.number().optional().describe('move/focus/place: world-space X'),
      y: z.number().optional().describe('move/focus/place: world-space Y'),
      w: z.number().optional().describe('move: width in canvas pixels'),
      h: z.number().optional().describe('move: height in canvas pixels'),
      minimized: z.boolean().optional().describe('move: collapse the widget to its header'),
      zoom: z.number().min(0.2).max(4).optional().describe('focus: 1 = normal scale, smaller zooms out'),
      baseVersion: z.number().optional().describe('rename/move: version from list — prevents overwriting a concurrent edit'),
      agentId: AgentId.optional()
    },
    (input) =>
      guard(async () => {
        const action = actionOf(input, ['list', 'place', 'rename', 'move', 'focus', 'close'] as const)
        switch (action) {
          case 'list':
            return controlApi('/widgets')
          case 'place': {
            return post('/widgets', {
              agentId: req(input.agentId, 'action:"place" needs your agentId'),
              kind: req(input.kind, 'action:"place" needs kind'),
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.x !== undefined ? { x: input.x } : {}),
              ...(input.y !== undefined ? { y: input.y } : {})
            })
          }
          case 'rename': {
            const id = req(input.id, 'action:"rename" needs id (from list)')
            return send(`/widgets/${encodeURIComponent(id)}`, 'PATCH', {
              agentId: req(input.agentId, 'action:"rename" needs your agentId'),
              title: req(input.title, 'action:"rename" needs title'),
              ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {})
            })
          }
          case 'move': {
            const id = req(input.id, 'action:"move" needs id (from list)')
            const body: Record<string, unknown> = {
              agentId: req(input.agentId, 'action:"move" needs your agentId')
            }
            for (const key of ['x', 'y', 'w', 'h'] as const) {
              if (input[key] !== undefined) body[key] = input[key]
            }
            if (input.minimized !== undefined) body.minimized = input.minimized
            if (input.baseVersion !== undefined) body.baseVersion = input.baseVersion
            return send(`/widgets/${encodeURIComponent(id)}`, 'PATCH', body)
          }
          case 'focus': {
            return post('/canvas/camera', {
              agentId: req(input.agentId, 'action:"focus" needs your agentId'),
              x: req(input.x, 'action:"focus" needs x'),
              y: req(input.y, 'action:"focus" needs y'),
              zoom: req(input.zoom ?? 1, 'action:"focus" needs zoom')
            })
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
}
