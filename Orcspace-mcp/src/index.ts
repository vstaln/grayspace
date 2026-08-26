import * as http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBrainTools, BRAIN_TOOL_NAMES } from './tools/brain.js'
import { registerTerminalTools, TERMINAL_TOOL_NAMES } from './tools/terminal.js'
import { registerCanvasTools, CANVAS_TOOL_NAMES } from './tools/canvas.js'
import { registerBoardTools, BOARD_TOOL_NAMES } from './tools/board.js'
import { registerLocksTools, LOCKS_TOOL_NAMES } from './tools/locks.js'
import { registerJournalTools, JOURNAL_TOOL_NAMES } from './tools/journal.js'
import { registerGitTools, GIT_TOOL_NAMES } from './tools/git.js'
import { registerPlannerTools, PLANNER_TOOL_NAMES } from './tools/planner.js'
import { createRequestListener, listenOnLoopback } from './http.js'

/**
 * Every tool registered in createServer. Kept as data so the request listener
 * can reject an unknown `tools/call` with a proper JSON-RPC -32602 instead of
 * the SDK's 200 + isError result. Nine tools, one per domain — the whole
 * surface a model must hold in context.
 */
export const TOOL_NAMES = new Set<string>([
  ...BRAIN_TOOL_NAMES,
  ...TERMINAL_TOOL_NAMES,
  ...CANVAS_TOOL_NAMES,
  ...BOARD_TOOL_NAMES,
  ...LOCKS_TOOL_NAMES,
  ...JOURNAL_TOOL_NAMES,
  ...GIT_TOOL_NAMES,
  ...PLANNER_TOOL_NAMES
])

// Shown to every agent that connects (Claude Code, Codex, opencode, …) as
// part of MCP's own handshake. Short on purpose: every line competes with
// the user's actual task for the model's attention.
const AGENT_INSTRUCTIONS = `You are inside OrcSpace — an infinite-canvas desktop app the user watches live. NINE tools cover everything; every write is journaled under your agentId.

## Rules
1. LOOK FIRST — before creating anything, run the domain's action:"list". Never duplicate what exists.
2. Pick ONE agentId now; reuse it in every write this session.
3. Destructive actions (close/delete) only when the user asked for exactly that.
4. On-canvas by default: "make X" becomes a note/task/widget, not a loose file.
5. Holding locks or the manager role during long work? call locks{action:"heartbeat"} now and then — silent locks expire and get given away.

## Tools (each takes action)
terminal_permission  allow|always|deny            — confirm Claude Code's visible permission picker; sends selection + Enter reliably
brain    list|read|search|save|update|delete   — durable notes; $ExactTitle in a body links notes
terminal open|send|read|close                  — real shells; loop send→read until you see what you need
canvas   list|place|rename|move|focus|close    — widgets & camera; terminals come from terminal{action:"open"}
board    status|list|create|claim|update|lock_file|become_manager|release_manager — multi-agent kanban; only the manager creates; claim locks the task's files
locks    list|lock|unlock|heartbeat            — reserve "scheme:id" (file:…, note:…, terminal:…, git:repo) before writing
plan     list|create|update|toggle|delete      — the user's day checklist, NOT the board
git      status|commit                          — lock git:repo before commit; never scrape terminals for git state
read_journal (since?)                          — who changed what, in order

Act with tools, then say what changed on the canvas. Always reply in English.`

export function createServer(): McpServer {
  // Not "workspace" — Claude Code reserves that exact name and silently drops
  // a server registered under it.
  const server = new McpServer({ name: 'OrcSpace', version: '2.0.0' }, { instructions: AGENT_INSTRUCTIONS })
  registerBrainTools(server)
  registerTerminalTools(server)
  registerCanvasTools(server)
  registerBoardTools(server)
  registerLocksTools(server)
  registerJournalTools(server)
  registerGitTools(server)
  registerPlannerTools(server)
  return server
}

export function createMcpRequestListener(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return createRequestListener(createServer, TOOL_NAMES)
}

// Library mode is used by the Electron main process. Standalone mode remains
// available for local MCP development and backwards-compatible CLI usage.
const standalone = process.env.ORCSPACE_EMBEDDED !== '1'
const requestListener = standalone ? createMcpRequestListener() : null
const server4 = requestListener ? listenOnLoopback(http.createServer(requestListener), '127.0.0.1') : null
const server6 = requestListener ? listenOnLoopback(http.createServer(requestListener), '::1') : null

const shutdown = (): void => {
  if (!server4 || !server6) return process.exit(0)
  server4.close(() => {
    server6.close(() => {
      process.exit(0)
    })
  })
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
