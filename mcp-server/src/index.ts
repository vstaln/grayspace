import * as http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBrainTools, BRAIN_TOOL_NAMES } from './tools/brain.js'
import { registerTerminalTools, TERMINAL_TOOL_NAMES } from './tools/terminals.js'
import { registerCoordinationTools, COORDINATION_TOOL_NAMES } from './tools/coordination.js'
import { registerWidgetTools, WIDGET_TOOL_NAMES } from './tools/widgets.js'
import { registerPlannerTools, PLANNER_TOOL_NAMES } from './tools/planner.js'
import { createRequestListener, listenOnLoopback } from './http.js'

/**
 * Every tool registered in createServer (P2-003b). Kept as data so the request
 * listener can reject an unknown `tools/call` with a proper JSON-RPC -32602
 * instead of the SDK's 200 + isError result — robust clients must be able to
 * tell a protocol error from a tool failure. The isolated-instance regression
 * (audit REGRESSION_PLAN 1.2) diffs this set against the live `tools/list`.
 */
const TOOL_NAMES = new Set<string>([
  ...BRAIN_TOOL_NAMES,
  ...TERMINAL_TOOL_NAMES,
  ...COORDINATION_TOOL_NAMES,
  ...WIDGET_TOOL_NAMES,
  ...PLANNER_TOOL_NAMES
])

// Shown to every agent that connects (Claude Code, Codex, opencode, …) as
// part of MCP's own handshake, so it doesn't need a file dropped into every
// project it happens to run in to know it's inside OrcSpace.
const AGENT_INSTRUCTIONS = `You are running inside OrcSpace, an infinite-canvas app that hosts your terminal alongside notes, a task board, and other agents. Anything you create — a terminal, a note, a plan item — is a widget on that shared canvas, visible to the user and to other agents working the same board.

Use these MCP tools instead of ad-hoc files or guesses when the user asks you to do things OrcSpace already models:
- terminals: create/list/write to terminal widgets
- brain notes: create/read/update/search notes on the canvas
- plan items / board: task tracking visible on the canvas
- coordination & locks: claim a resource before writing it if another agent might touch it too
- widgets: place, move, or close things on the canvas directly

If asked to "create" something with no more specific instruction, prefer placing it as a widget on the OrcSpace canvas over writing a bare file, so the user can see it.`

function createServer(): McpServer {
  // Not "workspace" — Claude Code reserves that exact name and silently drops
  // a server registered under it.
  const server = new McpServer({ name: 'OrcSpace', version: '2.0.0' }, { instructions: AGENT_INSTRUCTIONS })
  registerBrainTools(server)
  registerTerminalTools(server)
  registerCoordinationTools(server)
  registerWidgetTools(server)
  registerPlannerTools(server)
  return server
}

const requestListener = createRequestListener(createServer, TOOL_NAMES)
listenOnLoopback(http.createServer(requestListener), '127.0.0.1')
listenOnLoopback(http.createServer(requestListener), '::1')
