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
import { applyLoopbackCors, isLoopbackRequest, secretsEqual } from './netGuard.ts'
import { buildPresence, buildSnapshot } from './linkSnapshot.ts'
import type { AppState } from './appState'
import { fileResource, parseResource, type ActorType, type CommandErrorCode, type CommandResult, type Core } from './core/index.ts'

const MAX_BODY_BYTES = 1_000_000
const BODY_TIMEOUT_MS = 30_000

/**
 * Sliding-window request cap for the loopback API. The token gates
 * who may call, but a compromised local process that stole the token could
 * otherwise hammer the bus as fast as the event loop allows.
 */
const RATE_LIMIT_WINDOW_MS = 10_000
const RATE_LIMIT_MAX_PRESENCE = 120
const RATE_LIMIT_MAX_API = 600
let presenceTimes: number[] = []
let apiTimes: number[] = []

function rateLimitedPresence(): boolean {
  const now = Date.now()
  presenceTimes = presenceTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  if (presenceTimes.length >= RATE_LIMIT_MAX_PRESENCE) return true
  presenceTimes.push(now)
  return false
}

function rateLimitedApi(): boolean {
  const now = Date.now()
  apiTimes = apiTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  if (apiTimes.length >= RATE_LIMIT_MAX_API) return true
  apiTimes.push(now)
  return false
}

type Json = Record<string, unknown>

interface ControlDeps {
  core: Core
  terminals: TerminalManager
  coordination: CoordinationStore
  planner: PlannerStore
  brain: BrainStore
  canvas: CanvasStore
  state: AppState
  defaultCwd(): string | undefined
  /** Reports whether the bundled MCP server process is currently up. */
  mcpRunning(): boolean
  mcpStatus?(): { running: boolean; error?: string; pid?: number; restarts?: number }
  restartMcp?(): Promise<{ running: boolean; error?: string; pid?: number; restarts?: number }>
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
  failed: 500,
  rate_limited: 429,
  backpressure: 429,
  cancelled: 499
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
    applyLoopbackCors(req, res, `Content-Type, ${CONTROL_TOKEN_HEADER}`)
    const url = new URL(req.url || '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method || 'GET'

    // Presence and CORS preflight OPTIONS are unauthenticated:
    if (method === 'OPTIONS') {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback only' })
      res.writeHead(204)
      res.end()
      return
    }
    if (method === 'GET' && parts[0] === 'presence') {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (rateLimitedPresence()) return sendJson(res, 429, { error: 'too many requests' })
      return sendJson(
        res,
        200,
        buildPresence({ mcpRunning: deps.mcpRunning(), workspaceDir: deps.defaultCwd() ?? null })
      )
    }

    if (!isTrustedCaller(req, token)) {
      return sendJson(res, 401, { error: 'a valid control token is required' })
    }
    void route(req, res, deps).catch((err) => {
      console.error('control request failed', err)
      if (!res.headersSent) {
        const status = typeof (err as { statusCode?: unknown })?.statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 500
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
      }
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
  if (!isLoopbackRequest(req)) return false
  const presented = req.headers[CONTROL_TOKEN_HEADER]
  return typeof presented === 'string' && secretsEqual(presented, token)
}

/** Built-in actor ids that HTTP callers must never claim. */
const RESERVED_ACTOR_IDS = new Set(['user', 'assistant', 'system'])

/**
 * Validates and registers an HTTP agent id. Refuses reserved names and any id
 * already registered as a non-agent (so a token holder cannot ride the human
 * or the built-in assistant).
 */
function registerHttpAgent(
  core: Core,
  agentIdRaw: unknown
): { ok: true; agentId: string } | { ok: false; status: number; error: string; code: CommandErrorCode } {
  const agentId = String(agentIdRaw ?? '').trim()
  if (!agentId) {
    return { ok: false, status: 401, error: 'agentId is required', code: 'unknown_actor' }
  }
  // Bound actor ids so a hostile client cannot grow the actor registry forever
  // with multi-megabyte keys (the body cap is 1MB, but ids are stored long-lived).
  if (agentId.length > 128 || !/^[a-zA-Z0-9._@:-]+$/.test(agentId)) {
    return {
      ok: false,
      status: 400,
      error: 'agentId must be 1–128 chars of [A-Za-z0-9._@:-]',
      code: 'invalid'
    }
  }
  if (RESERVED_ACTOR_IDS.has(agentId)) {
    return {
      ok: false,
      status: 403,
      error: `agentId "${agentId}" is reserved`,
      code: 'forbidden'
    }
  }
  const existing = core.actors.get(agentId)
  if (existing && existing.type !== 'agent') {
    return {
      ok: false,
      status: 403,
      error: `agentId "${agentId}" is not an agent actor`,
      code: 'forbidden'
    }
  }
  core.actors.register({ id: agentId, type: 'agent', label: agentId, transport: 'http' })
  return { ok: true, agentId }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, deps: ControlDeps): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  const method = req.method || 'GET'
  const { terminals, coordination, planner, brain, canvas, core } = deps

  if (rateLimitedApi()) {
    return sendJson(res, 429, { error: 'too many requests' })
  }

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
    _options: { actorType?: ActorType } = {}
  ): Promise<CommandResult<T>> => {
    // HTTP is always an agent transport. actorType is ignored so a client cannot
    // escalate to user/assistant/system by asking.
    const rawAgentId = body.agentId ?? url.searchParams.get('agentId') ?? req.headers['x-agent-id']
    const registered = registerHttpAgent(core, rawAgentId)
    if (!registered.ok) {
      return { ok: false, code: registered.code, message: registered.error }
    }
    // Any call is a liveness signal, which is what keeps this agent's locks
    // alive; go quiet for a minute and they are swept.
    core.locks.heartbeat(registered.agentId)
    const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : undefined
    return core.bus.submit<T>({ actorId: registered.agentId, type, target, payload, baseVersion })
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

  // ---- snapshot (dashboard one-shot) --------------------------------------
  if (method === 'GET' && parts[0] === 'snapshot') {
    const coord = coordination.snapshot()
    const plannerItems = planner.list()
    const shells = terminals.list().map((t) => ({ ...t, kind: 'terminal' as const }))
    const others = canvas
      .listWidgets()
      .filter((w) => w.kind !== 'terminal')
      .map((w) => ({ id: w.id, title: w.title, kind: w.kind ?? 'note', noteId: w.noteId, version: w.version }))
    const sinceRaw = Number(url.searchParams.get('since') || Math.max(0, core.journal.lastSeq - 40))
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : Math.max(0, core.journal.lastSeq - 40)
    return sendJson(
      res,
      200,
      buildSnapshot({
        mcpRunning: deps.mcpRunning(),
        workspaceDir: deps.defaultCwd() ?? null,
        managerId: coord.managerId,
        terminals: shells,
        widgets: [...shells, ...others],
        tasks: coord.tasks,
        locks: core.locks.list(),
        plannerItems,
        brainNotes: brain.snapshot().notes,
        journal: { lastSeq: core.journal.lastSeq, entries: core.journal.since(since) },
        commands: core.bus.types(),
        mcp: deps.mcpStatus?.()
      })
    )
  }

  // ---- mcp supervisor -----------------------------------------------------
  if (parts[0] === 'mcp') {
    if (method === 'GET' && parts.length === 1) {
      return sendJson(res, 200, deps.mcpStatus?.() ?? { running: deps.mcpRunning() })
    }
    if (method === 'POST' && parts[1] === 'restart') {
      if (!deps.restartMcp) return sendJson(res, 501, { error: 'mcp restart is not available' })
      const status = await deps.restartMcp()
      return sendJson(res, 200, status)
    }
  }

  // ---- locks --------------------------------------------------------------
  // First-class now that they protect resources: an agent about to touch a
  // file takes the lock explicitly and holds it across several commands.
  if (parts[0] === 'locks') {
    if (method === 'GET') return sendJson(res, 200, { locks: core.locks.list() })
    const body = await readJson(req)
    const rawAgentId = body.agentId ?? url.searchParams.get('agentId') ?? req.headers['x-agent-id']
    const registered = registerHttpAgent(core, rawAgentId)
    if (!registered.ok) return sendJson(res, registered.status, { error: registered.error, code: registered.code })
    const agentId = registered.agentId
    try {
      if (method === 'POST' && parts[1] === 'heartbeat') {
        return sendJson(res, 200, { renewed: core.locks.heartbeat(agentId) })
      }
      if (method === 'POST') {
        const lock = core.locks.acquire({
          resource: normalizeLockResource(body.resource),
          actorId: agentId,
          ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
          reason: typeof body.reason === 'string' ? body.reason : undefined
        })
        return sendJson(res, 200, { lock })
      }
      if (method === 'DELETE' && parts[1]) {
        core.locks.release(normalizeLockResource(decodeURIComponent(parts[1])), agentId)
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
    const sinceRaw = Number(url.searchParams.get('since') || 0)
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0
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

    // Extra file reservation mid-task (MCP lock_task_file). Appends the path to
    // the card so later state transitions renew/release it with the rest.
    if (method === 'POST' && parts[1] === 'locks') {
      const body = await readJson(req)
      const registered = registerHttpAgent(core, body.agentId)
      if (!registered.ok) return sendJson(res, registered.status, { error: registered.error, code: registered.code })
      try {
        const lock = coordination.lockExtraFile(
          String(body.taskId ?? ''),
          registered.agentId,
          String(body.path ?? ''),
          typeof body.ttlMs === 'number' ? body.ttlMs : undefined
        )
        return sendJson(res, 200, { lock })
      } catch (err) {
        const code = (err as { code?: CommandErrorCode }).code ?? 'failed'
        return sendJson(res, STATUS_BY_CODE[code] ?? 400, {
          error: (err as Error).message,
          code,
          ...((err as { details?: Json }).details ?? {})
        })
      }
    }

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
      const items = planner.list()
      const today = localDayKey()
      const weekEnd = shiftLocalDay(today, 6)
      const open = items.filter((i) => !i.done)
      const done = items.filter((i) => i.done)
      const todayItems = items.filter((i) => i.day === today)
      const weekItems = items.filter((i) => i.day && i.day >= today && i.day <= weekEnd)
      return sendJson(res, 200, {
        items,
        summary: {
          total: items.length,
          open: open.length,
          done: done.length,
          today: todayItems.length,
          todayOpen: todayItems.filter((i) => !i.done).length,
          week: weekItems.length,
          weekOpen: weekItems.filter((i) => !i.done).length,
          projects: uniqueProjects(items)
        }
      })
    }
    if (method === 'POST' && parts.length === 1) {
      const body = await readJson(req)
      return reply(await submit(body, 'plan.create', NEW.plan, body), 201)
    }
    if (method === 'POST' && parts[1] && parts[2] === 'toggle') {
      const body = await readJson(req)
      return reply(
        await submit(body, 'plan.toggle', `plan:${decodeURIComponent(parts[1])}`, {
          done: typeof body.done === 'boolean' ? body.done : undefined
        })
      )
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
    // `full=1` bypasses the agent read-offset and returns the whole retained
    // scrollback (bounded by OUTPUT_BUFFER_LIMIT) instead of only what
    // arrived since the last poll. A TUI that redraws by cursor-skipping over
    // already-drawn text (Claude Code's Ink renderer does this) means a
    // delta-only read can be missing the literal characters a later frame's
    // skip-forward silently relies on still being on screen; the full buffer
    // usually still has them.
    if (url.searchParams.get('full') === '1') {
      const output = terminals.fullOutput(id)
      if (output === null) return sendJson(res, 404, { error: 'terminal not found' })
      return sendJson(res, 200, { output })
    }
    const output = terminals.readOutput(id, url.searchParams.get('clear') === '1')
    if (output === null) return sendJson(res, 404, { error: 'terminal not found' })
    return sendJson(res, 200, { output })
  }

  sendJson(res, 404, { error: 'not found' })
}

function readJson(req: http.IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    // Buffers are collected whole and decoded once at the end — decoding each
    // chunk on its own (e.g. via `body += chunk`) can split a multi-byte UTF-8
    // character across a chunk boundary and silently corrupt it.
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const fail = (statusCode: number, message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Stop reading so a hostile client cannot keep the stream open after 413.
      req.destroy()
      const error = new Error(message) as Error & { statusCode: number }
      error.statusCode = statusCode
      reject(error)
    }
    const timer = setTimeout(() => fail(408, 'request body timed out'), BODY_TIMEOUT_MS)
    timer.unref?.()
    req.on('close', () => {
      if (!settled && !req.complete) fail(499, 'client closed request')
    })
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        fail(413, 'request body too large')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          const error = new Error('request body must be a JSON object') as Error & { statusCode: number }
          error.statusCode = 400
          reject(error)
          return
        }
        resolve(parsed as Json)
      } catch {
        const error = new Error('request body must be valid JSON') as Error & { statusCode: number }
        error.statusCode = 400
        reject(error)
      }
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** HTTP callers pass `file:C:\src\a.ts` or a raw path; locks only match `fileResource()`. */
function normalizeLockResource(raw: unknown): string {
  const text = String(raw ?? '').trim()
  const parsed = parseResource(text)
  if (parsed?.scheme === 'file') return fileResource(parsed.id)
  if (/^[A-Za-z]:[\\/]/.test(text) || text.includes('\\') || text.startsWith('/')) return fileResource(text)
  return text
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  // readJson() destroys the request socket on 413/408/499, which also takes the
  // shared socket out from under the response; writeHead would then throw inside
  // a caller's catch handler and surface as an unhandled rejection.
  if (res.headersSent || res.destroyed || res.writableEnded) return
  const body = JSON.stringify(data)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      // Control API is loopback-only and token-gated; still refuse embedding and
      // MIME sniffing so a compromised renderer cannot treat responses as HTML.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    })
    res.end(body)
  } catch {
    // The socket raced away before the response could be written; nothing left
    // to answer, and nothing the caller can do about it.
  }
}

/** Local calendar day as `YYYY-MM-DD` — same convention as the planner widget. */
function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftLocalDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return localDayKey(date)
}

function uniqueProjects(items: { project?: string }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const p = item.project?.trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

export { USER_AUTHOR }
