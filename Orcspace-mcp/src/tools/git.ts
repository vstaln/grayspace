import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post } from '../control.js'
import { AgentId, actionOf, guard, req } from '../util.js'

export const GIT_TOOL_NAMES = ['git']

export function registerGitTools(server: McpServer): void {
  server.tool(
    'git',
    'Git for the open project folder. Actions: status | commit. commit stages everything — lock git:repo first via locks{action:"lock",resource:"git:repo"} so another agent cannot commit a half-ready tree under you. Never scrape terminal output; use status.',
    {
      action: z.enum(['status', 'commit']).describe('status = branch/changed/ahead-behind/last commit; commit = stage all + commit'),
      message: z.string().optional().describe('commit: human-readable message (the user sees it in history)'),
      agentId: AgentId.optional()
    },
    (input) =>
      guard(async () => {
        const action = actionOf(input, ['status', 'commit'] as const)
        switch (action) {
          case 'status':
            return controlApi('/git/status')
          case 'commit':
            return post('/git/commit', {
              agentId: req(input.agentId, 'action:"commit" needs your agentId'),
              message: req(input.message, 'action:"commit" needs message')
            })
        }
      })
  )
}
