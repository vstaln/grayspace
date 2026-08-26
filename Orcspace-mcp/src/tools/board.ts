import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { controlApi, post, send } from '../control.js'
import { AgentId, actionOf, guard, req } from '../util.js'

export const BOARD_TOOL_NAMES = ['board']

/**
 * The kanban board agents coordinate through. One manager creates work;
 * workers claim tasks — claiming auto-locks the task's files.
 */
export function registerBoardTools(server: McpServer): void {
  server.tool(
    'board',
    'Kanban board for multi-agent work. Actions: status | list | create | claim | update | lock_file | become_manager | release_manager. Only the manager (become_manager) may create tasks. Prefer tasks with createdBy="user" — a human wrote those. claim reserves the task AND locks its files; never edit its files before claiming.',
    {
      action: z.enum(['status', 'list', 'create', 'claim', 'update', 'lock_file', 'become_manager', 'release_manager']).describe(
        'status = manager+locks overview; list = cards; create = manager only; claim = take a queued task; update = move state; lock_file = extra file found mid-work; become/release_manager'
      ),
      taskId: z.string().optional().describe('claim / update / lock_file: task id from list'),
      title: z.string().optional().describe('create: card title'),
      brief: z.string().optional().describe('create: what to do + acceptance criteria'),
      files: z.array(z.string()).optional().describe('create: files the task touches (auto-locked on claim)'),
      maxSteps: z.number().int().min(1).max(100).optional().describe('create: worker step budget'),
      maxReviewIterations: z.number().int().min(1).max(10).optional().describe('create: review loop budget'),
      state: z
        .enum(['backlog', 'queued', 'in_progress', 'review', 'done', 'cancelled'])
        .optional()
        .describe('update: target column'),
      path: z.string().optional().describe('lock_file: file discovered mid-task'),
      ttlMs: z.number().int().min(1000).max(600000).optional().describe('lock_file: TTL ms (default 30s, max 10 min)'),
      agentId: AgentId.optional()
    },
    (input) =>
      guard(async () => {
        const action = actionOf(input, [
          'status',
          'list',
          'create',
          'claim',
          'update',
          'lock_file',
          'become_manager',
          'release_manager'
        ] as const)
        switch (action) {
          case 'status':
            return controlApi('/coordination/status')
          case 'list':
            return controlApi('/coordination/tasks')
          case 'create': {
            return post('/coordination/tasks', {
              agentId: req(input.agentId, 'action:"create" needs your agentId'),
              title: req(input.title, 'action:"create" needs title'),
              ...(input.brief !== undefined ? { brief: input.brief } : {}),
              ...(input.files ? { files: input.files } : {}),
              ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
              ...(input.maxReviewIterations !== undefined ? { maxReviewIterations: input.maxReviewIterations } : {})
            })
          }
          case 'claim': {
            const taskId = req(input.taskId, 'action:"claim" needs taskId (from list)')
            return post(`/coordination/tasks/${encodeURIComponent(taskId)}/claim`, {
              agentId: req(input.agentId, 'action:"claim" needs your agentId')
            })
          }
          case 'update': {
            const taskId = req(input.taskId, 'action:"update" needs taskId')
            return send(`/coordination/tasks/${encodeURIComponent(taskId)}`, 'PATCH', {
              agentId: req(input.agentId, 'action:"update" needs your agentId'),
              state: req(input.state, 'action:"update" needs state (backlog|queued|in_progress|review|done|cancelled)')
            })
          }
          case 'lock_file': {
            return post('/coordination/locks', {
              agentId: req(input.agentId, 'action:"lock_file" needs your agentId'),
              taskId: req(input.taskId, 'action:"lock_file" needs taskId'),
              path: req(input.path, 'action:"lock_file" needs path'),
              ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {})
            })
          }
          case 'become_manager':
            return post('/coordination/manager', {
              agentId: req(input.agentId, 'action:"become_manager" needs your agentId')
            })
          case 'release_manager':
            return send('/coordination/manager', 'DELETE', {
              agentId: req(input.agentId, 'action:"release_manager" needs your agentId')
            })
        }
      })
  )
}
