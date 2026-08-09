import * as http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBrainTools, BRAIN_TOOL_NAMES } from './tools/brain.js'
import { registerTerminalTools, TERMINAL_TOOL_NAMES } from './tools/terminals.js'
import { registerCoordinationTools, COORDINATION_TOOL_NAMES } from './tools/coordination.js'
import { registerWidgetTools, WIDGET_TOOL_NAMES } from './tools/widgets.js'
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
  ...WIDGET_TOOL_NAMES
])

function createServer(): McpServer {
  // Not "workspace" — Claude Code reserves that exact name and silently drops
  // a server registered under it.
  const server = new McpServer({ name: 'workspace-app', version: '2.0.0' })
  registerBrainTools(server)
  registerTerminalTools(server)
  registerCoordinationTools(server)
  registerWidgetTools(server)
  return server
}

const requestListener = createRequestListener(createServer, TOOL_NAMES)
listenOnLoopback(http.createServer(requestListener), '127.0.0.1')
listenOnLoopback(http.createServer(requestListener), '::1')
