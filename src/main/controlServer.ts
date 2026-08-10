import * as http from 'http'
import { CONTROL_PORT, MCP_PORT, MCP_SERVER_NAME, mcpUrl } from './config'
import { CoordinationStore, USER_AUTHOR } from './coordination'
import { TerminalManager } from './terminals'
import { BrainStore } from './brain'
import { CanvasStore } from './canvasState'
import type { PlannerStore } from './plannerStore.ts'
import { CONTROL_TOKEN_HEADER, controlToken } from './controlToken'
import { CANVAS_TARGET } from './commands/canvas.ts'
import { TASK_MANAGER_TARGET } from './commands/board.ts'
import { GIT_TARGET } from './commands/git.ts'
import { NEW } from './commands/index.ts'
import type { ActorType, CommandErrorCode, CommandResult, Core } from './core/index.ts'

type Json = Record<string, unknown>

interface ControlDeps {
  core: Core
  terminals: TerminalManager
  coordination: CoordinationStore
  planner: PlannerStore
  brain: BrainStore
  canvas: CanvasStore
  defaultCwd(): string | undefined
  /** Reports whether the bundled MCP server process is currently up. */
  mcpRunning(): boolean
}

/** How a failed command maps onto HTTP for callers that only speak status codes. */
const STATUS_BY_CODE: Record<CommandErrorCode, number> = {
  conflict: 409,
  locked: 409,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  unknown_command: 400,
  unknown_actor: 401,
  failed: 500
}

/**
 * Loopback-only HTTP surface that the MCP server (and any local tooling)
 * drives the app through.
 *
 * It is a *transport*, and after the core refactor that is all it is: it
 * authenticates a caller, turns the request into a command, and renders the
 * result as JSON. There is no state logic left in this file — no lock checks,
 * no manager rules, no store writes — because those now live in exactly one
 * place for all three transports.
 */
export function startControlServer(deps: ControlDeps): http.Server {
  const token = controlToken()
  const server = http.createServer((req, res) => {
    if (!isTrustedCaller(req, token)) {
      return sendJson(res, 401, { error: 'a valid control token is required' })
    }
    void route(req, res, deps).catch((err) => {
      console.error('control request failed', err)
      if (!res.headersSent) sendJson(res, 500, { error: String(err) })
    })
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `control port ${CONTROL_PORT} is already in use — another OrcSpace instance is probably running.`
      )
      return
    }
    console.error('control server error', err)
  })
  server.listen(CONTROL_PORT, '127.0.0.1', () => {
    console.log(`control server listening on http://127.0.0.1:${CONTROL_PORT}`)
  })
  return server
}

/**
 * Two gates, and the second one is the one that matters.
 *
 * Binding to loopback keeps the network out but not the browser: any page the
 * user visits can POST to 127.0.0.1, and this API opens shells. The old rule —
 * "no Origin header means a trusted local tool" — gave every process on the
 * machine arbitrary command execution, since a plain HTTP client sends no
 * Origin either. So the header check stays (it is cheap, and it blocks
 * DNS-rebinding), but the actual authority is a token generated at startup and
 * written to a file only this user can read.
 */
function isTrustedCaller(req: http.IncomingMessage, token: string): boolean {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && !isLoopbackUrl(origin)) return false
  const host = req.headers.host
  if (typeof host === 'string' && host && !isLoopbackHost(host)) return false
  const presented = req.headers[CONTROL_TOKEN_HEADER]
  return typeof presented === 'string' && timingSafeEqual(presented, token)
}

/** Constant-time compare so the token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).host)
  } catch {
    return false
  }
}

function isLoopbackHost(host: string): boolean {
  // Strip the port, and the brackets IPv6 literals carry in a Host header.
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, deps: ControlDeps): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  const method = req.method || 'GET'
  const { terminals, coordination, planner, brain, canvas, core } = deps

  /**
   * Registers the caller and submits one command as them. Every external
   * writer arrives with an `agentId` in its body; it becomes an `agent` actor,
   * which is how the journal can later say which CLI moved what.
   */
  const submit = async <T>(
    body: Json,
    type: string,
    target: string,
    payload: unknown,
    options: { actorType?: ActorType } = {}
  ): Promise<CommandResult<T>> => {
    const agentId = String(body.agentId ?? '').trim()
    if (!agentId) {
      return { ok: false, code: 'unknown_actor', message: 'agentId is required' }
    }
    core.actors.register({
      id: agentId,
      type: options.actorType ?? 'agent',
      label: agentId,
      transport: 'http'
    })
    // Any call is a liveness signal, which is what keeps this agent's locks
    // alive; go quiet for a minute and they are swept.
    core.locks.heartbeat(agentId)
    const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : undefined
    return core.bus.submit<T>({ actorId: agentId, type, target, payload, baseVersion })
  }

  const reply = <T>(result: CommandResult<T>, okStatus = 200): void => {
    if (result.ok) return sendJson(res, okStatus, { ok: true, version: result.version, seq: result.seq, data: result.data })
    return sendJson(res, STATUS_BY_CODE[result.code] ?? 400, {
      error: result.message,
      code: result.code,
      ...result.details
    })
  }

  // ---- health ------------------------------------------------------------
  if (method === 'GET' && (parts.length === 0 || parts[0] === 'health')) {
    return sendJson(res, 200, {
      ok: true,
      app: 'orcspace',
      server: MCP_SERVER_NAME,
      controlPort: CONTROL_PORT,
      mcpPort: MCP_PORT,
      mcpUrl: mcpUrl(MCP_PORT),
      mcpRunning: deps.mcpRunning(),
      workspaceDir: deps.defaultCwd() ?? null,
      terminals: terminals.list().length,
      managerId: coordination.managerId,
      commands: core.bus.types()
    })
  }

  // ---- locks --------------------------------------------------------------
  // First-class now that they protect resources: an agent about to touch a
  // file takes the lock explicitly and holds it across several commands.
  if (parts[0] === 'locks') {
    if (method === 'GET') return sendJson(res, 200, { locks: core.locks.list() })
    const body = await readJson(req)
    const agentId = String(body.agentId ?? '').trim()
    if (!agentId) return sendJson(res, 401, { error: 'agentId is required' })
    core.actors.register({ id: agentId, type: 'agent', label: agentId, transport: 'http' })
    try {
      if (method === 'POST' && parts[1] === 'heartbeat') {
        return sendJson(res, 200, { renewed: core.locks.heartbeat(agentId) })
      }
      if (method === 'POST') {
        const lock = core.locks.acquire({
          resource: String(body.resource ?? ''),
          actorId: agentId,
          ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
          reason: typeof body.reason === 'string' ? body.reason : undefined
        })
        return sendJson(res, 200, { lock })
      }
      if (method === 'DELETE' && parts[1]) {
        core.locks.release(decodeURIComponent(parts[1]), agentId)
        return sendJson(res, 200, { ok: true })
      }
    } catch (err) {
      const code = (err as { code?: CommandErrorCode }).code ?? 'failed'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, {
        error: (err as Error).message,
        code,
        ...((err as { details?: Json }).details ?? {})
      })
    }
  }

  // ---- git ----------------------------------------------------------------
  if (parts[0] === 'git') {
    const body = method === 'GET' ? {} : await readJson(req)
    if (method === 'GET' && parts[1] === 'status') {
      // Status is a read, but it still goes through the bus so the refresh is
      // journaled next to whatever the agent does with the answer.
      core.actors.register({ id: 'system', type: 'system', label: 'OrcSpace', transport: 'internal' })
      return reply(await core.bus.submit({ actorId: 'system', type: 'git.refresh', target: GIT_TARGET, payload: {} }))
    }
    if (method === 'POST' && parts[1] === 'commit') {
      return reply(await submit(body, 'git.commit', GIT_TARGET, { message: body.message }))
    }
  }

  // ---- journal ------------------------------------------------------------
  // The audit trail, readable by tooling: who changed what, in order.
  if (method === 'GET' && parts[0] === 'journal') {
    const since = Number(url.searchParams.get('since') || 0)
    return sendJson(res, 200, { lastSeq: core.journal.lastSeq, entries: core.journal.since(since) })
  }

  // ---- second brain -------------------------------------------------------
  if (parts[0] === 'brain') {
    if (method === 'GET' && parts.length === 1) return sendJson(res, 200, brain.snapshot())
    if (method === 'GET' && parts[1] === 'search')
      return sendJson(res, 200, { notes: brain.search(url.searchParams.get('q') || '') })
    if (method === 'POST' && parts.length === 1) {
      const body = await readJson(req)
      return reply(await submit(body, 'note.create', NEW.note, body), 201)
    }
    if (method === 'PATCH' && parts[1]) {
      const body = await readJson(req)
      return reply(await submit(body, 'note.update', `note:${decodeURIComponent(parts[1])}`, body))
    }
    if (method === 'DELETE' && parts[1]) {
      const body = await readJson(req)
      return reply(await submit(body, 'note.delete', `note:${decodeURIComponent(parts[1])}`, {}))
    }
  }

  // ---- coordination -------------------------------------------------------
  if (parts[0] === 'coordination') {
    if (method === 'GET' && parts[1] === 'status') return sendJson(res, 200, coordination.snapshot())
    if (method === 'GET' && parts[1] === 'tasks') return sendJson(res, 200, { tasks: coordination.snapshot().tasks })
    if (method === 'GET' && parts[1] === 'locks') return sendJson(res, 200, { locks: core.locks.list() })

    if (method === 'POST' && parts[1] === 'manager') {
      const body = await readJson(req)
      return reply(await submit(body, 'manager.claim', TASK_MANAGER_TARGET, {}))
    }
    if (method === 'DELETE' && parts[1] === 'manager') {
      const body = await readJson(req)
      return reply(await submit(body, 'manager.release', TASK_MANAGER_TARGET, {}))
    }
    if (method === 'POST' && parts[1] === 'tasks' && parts.length === 2) {
      const body = await readJson(req)
      return reply(await submit(body, 'task.create', NEW.task, body), 201)
    }
    if (method === 'POST' && parts[1] === 'tasks' && parts[3] === 'claim') {
      const body = await readJson(req)
      return reply(await submit(body, 'task.claim', `task:${decodeURIComponent(parts[2])}`, {}))
    }
    if (method === 'PATCH' && parts[1] === 'tasks' && parts.length === 3) {
      const body = await readJson(req)
      return reply(await submit(body, 'task.update', `task:${decodeURIComponent(parts[2])}`, body))
    }
    if (method === 'DELETE' && parts[1] === 'tasks' && parts.length === 3) {
      const body = await readJson(req)
      return reply(await submit(body, 'task.delete', `task:${decodeURIComponent(parts[2])}`, {}))
    }
  }

  // ---- planner ------------------------------------------------------------
  // Personal day outline, separate from the kanban board. Agents (especially a
  // manager) may list and edit plan lines the same way the planner widget does.
  if (parts[0] === 'planner') {
    if (method === 'GET' && parts.length === 1) {
      return sendJson(res, 200, { items: planner.list() })
    }
    if (method === 'POST' && parts.length === 1) {
      const body = await readJson(req)
      return reply(await submit(body, 'plan.create', NEW.plan, body), 201)
    }
    if (method === 'PATCH' && parts[1]) {
      const body = await readJson(req)
      return reply(await submit(body, 'plan.update', `plan:${decodeURIComponent(parts[1])}`, body))
    }
    if (method === 'DELETE' && parts[1]) {
      const body = await readJson(req)
      return reply(await submit(body, 'plan.delete', `plan:${decodeURIComponent(parts[1])}`, {}))
    }
  }

  // ---- widgets / terminals ------------------------------------------------
  if (method === 'GET' && parts[0] === 'widgets' && parts.length === 1) {
    const others = canvas
      .listWidgets()
      .filter((w) => w.kind !== 'terminal')
      .map((w) => ({ id: w.id, title: w.title, kind: w.kind ?? 'note', noteId: w.noteId, version: w.version }))
    const shells = terminals.list().map((t) => ({ ...t, kind: 'terminal' as const }))
    return sendJson(res, 200, { widgets: [...shells, ...others] })
  }

  if (method === 'POST' && parts[0] === 'widgets' && parts[1] === 'terminal') {
    const body = await readJson(req)
    return reply(
      await submit(body, 'terminal.create', NEW.terminal, {
        title: typeof body.title === 'string' ? body.title : undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        agentOwned: true
      })
    )
  }

  if (method === 'DELETE' && parts[0] === 'widgets' && parts[1]) {
    const id = decodeURIComponent(parts[1])
    const body = await readJson(req)
    if (terminals.has(id)) return reply(await submit(body, 'terminal.dispose', `terminal:${id}`, {}))
    return reply(await submit(body, 'widget.remove', `widget:${id}`, {}))
  }

  if (method === 'POST' && parts[0] === 'widgets' && parts.length === 1) {
    const body = await readJson(req)
    return reply(await submit(body, 'widget.create', NEW.widget, body), 201)
  }

  if (method === 'PATCH' && parts[0] === 'widgets' && parts[1]) {
    const body = await readJson(req)
    return reply(await submit(body, 'widget.update', `widget:${decodeURIComponent(parts[1])}`, body))
  }

  if (method === 'POST' && parts[0] === 'canvas' && parts[1] === 'camera') {
    const body = await readJson(req)
    return reply(await submit(body, 'canvas.camera', CANVAS_TARGET, body))
  }

  if (method === 'POST' && parts[0] === 'terminal' && parts[2] === 'write') {
    const id = decodeURIComponent(parts[1])
    const body = await readJson(req)
    return reply(
      await submit(body, 'terminal.write', `terminal:${id}`, {
        text: typeof body.text === 'string' ? body.text : '',
        pressEnter: body.pressEnter !== false
      })
    )
  }

  if (method === 'GET' && parts[0] === 'terminal' && parts[2] === 'output') {
    const id = decodeURIComponent(parts[1])
    const output = terminals.readOutput(id, url.searchParams.get('clear') === '1')
    if (output === null) return sendJson(res, 404, { error: 'terminal not found' })
    return sendJson(res, 200, { output })
  }

  sendJson(res, 404, { error: 'not found' })
}

function readJson(req: http.IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let body = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      body += chunk
      if (body.length > 1_000_000) {
        tooLarge = true
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      if (!body) return resolve({})
      try {
        resolve(JSON.parse(body) as Json)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

export { USER_AUTHOR }
