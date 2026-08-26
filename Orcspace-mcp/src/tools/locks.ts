import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, send } from '../control.js'
import { AgentId, actionOf, guard, req } from '../util.js'

export const LOCKS_TOOL_NAMES = ['locks']

/**
 * Resource reservations shared by every actor in the app. Address resources
 * as scheme:id — file:src/a.ts, note:note-17, terminal:term-3, git:repo.
 */
export function registerLocksTools(server: McpServer): void {
  server.tool(
    'locks',
    'Reserve a resource before writing it so concurrent agents cannot collide. Actions: list | lock | unlock | heartbeat. Resource = scheme:id ("file:src/main/index.ts", "note:note-17", "terminal:term-3", "git:repo"). Locks have a TTL and expire if you go silent — heartbeat extends ALL your locks in one call during long work.',
    {
      action: z.enum(['list', 'lock', 'unlock', 'heartbeat']).describe(
        'list = who holds what; lock = reserve one resource; unlock = release it; heartbeat = extend all your locks (long work)'
      ),
      resource: z.string().optional().describe('lock / unlock: "scheme:id", e.g. file:src/main/index.ts'),
      ttlMs: z.number().optional().describe('lock: TTL ms (default 30s, max 10 min)'),
      reason: z.string().optional().describe('lock: why — visible to the user and journaled'),
      agentId: AgentId.optional()
    },
    (input) =>
      guard(async () => {
        const action = actionOf(input, ['list', 'lock', 'unlock', 'heartbeat'] as const)
        switch (action) {
          case 'list':
            return controlApi('/locks')
          case 'lock': {
            return post('/locks', {
              agentId: req(input.agentId, 'action:"lock" needs your agentId'),
              resource: req(input.resource, 'action:"lock" needs resource as scheme:id'),
              ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
              ...(input.reason !== undefined ? { reason: input.reason } : {})
            })
          }
          case 'unlock': {
            const resource = req(input.resource, 'action:"unlock" needs resource')
            return send(`/locks/${encodeURIComponent(resource)}`, 'DELETE', {
              agentId: req(input.agentId, 'action:"unlock" needs your agentId')
            })
          }
          case 'heartbeat':
            return post('/locks/heartbeat', {
              agentId: req(input.agentId, 'action:"heartbeat" needs your agentId')
            })
        }
      })
  )
}
