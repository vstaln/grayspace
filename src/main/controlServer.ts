import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import { basename, extname, join, normalize, resolve, sep } from 'path'
import { CONTROL_PORT, MAX_TERMINAL_WRITE_BYTES, getActiveControlPort, setActiveControlPort } from './config.ts'
import { getIpcSocketPath, prepareSocketPath, setActiveSocketPath } from './ipcSocket.ts'
import { TerminalManager } from './terminals.ts'
import { CanvasStore } from './canvasState.ts'
import type { PlannerStore } from './plannerStore.ts'
import type { OrchestrationStore } from './orchestration/store.ts'
import { MESSAGE_TYPES, TASK_STATUSES, type MessageType } from './orchestration/types.ts'
import { listWorkers, resolveWorker } from './orchestration/workers.ts'
import { CONTROL_TOKEN_HEADER, controlToken, controlTokenPersistError } from './controlToken.ts'
import { CANVAS_TARGET } from './commands/canvas.ts'
import { GIT_TARGET } from './commands/git.ts'
import { NEW } from './commands/index.ts'
import { applyLoopbackCors, isLoopbackRequest, secretsEqual } from './netGuard.ts'
import { APP_VERSION, buildPresence, buildSnapshot } from './linkSnapshot.ts'
import type { AppState } from './appState.ts'
import { ActorRateLimiter, fileResource, parseResource, type ActorType, type CommandErrorCode, type CommandResult, type Core } from './core/index.ts'
import { resolveImage } from './imageAttachments.ts'
import { hasImageExtension, hasAudioExtension, hasVideoExtension, hasDocExtension, importFile, isLocalPath } from './media.ts'

const MAX_BODY_BYTES = 1_000_000
const BODY_TIMEOUT_MS = 30_000






const RATE_LIMIT_WINDOW_MS = 10_000
const RATE_LIMIT_MAX_PRESENCE = 120

/**
 * Per-caller budget for the authenticated API.
 *
 * This used to be one global window — 600 requests per 10s shared by every
 * agent, the CLI and the app's own polling. A fleet is exactly the load this
 * server is for, and when the shared budget tripped *everyone* got 429,
 * including the coordinator trying to unblock the agent that caused it. The
 * app took itself down under its intended workload.
 *
 * A bucket per caller is strictly more permissive than the old ceiling and
 * still bounds a runaway loop, because the loop can now only starve itself.
 * The sustained rate matches what the old global allowed in total, so a single
 * well-behaved agent is no more restricted than before.
 */
const API_BUCKET_CAPACITY = 120
const API_REFILL_PER_SEC = 60

export const apiRateLimiter = new ActorRateLimiter({
  capacity: API_BUCKET_CAPACITY,
  refillPerSec: API_REFILL_PER_SEC
})

/**
 * Presence stays a single global window, and that is deliberate rather than an
 * oversight: it is answered *before* the token check, so its callers are
 * unauthenticated and indistinguishable — every one of them is loopback with an
 * ephemeral port, and there is nothing to key a bucket on. The blast radius is
 * also different: presence is a discovery read, so exhausting it degrades
 * discovery rather than breaking the command bus.
 */
let presenceTimes: number[] = []

function rateLimitedPresence(): boolean {
  const now = Date.now()
  presenceTimes = presenceTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  if (presenceTimes.length >= RATE_LIMIT_MAX_PRESENCE) return true
  presenceTimes.push(now)
  return false
}

/** The bucket a request is charged to. */
export function rateLimitKey(agentIdRaw: unknown): string {
  const agentId = String(agentIdRaw ?? '').trim()
  // A caller that names no agent shares one bucket. It has already passed the
  // token check, so it is trusted; it just cannot be told apart from other
  // unnamed callers, and lumping them together is safer than exempting them.
  return agentId ? `agent:${agentId}` : 'anonymous'
}

function rateLimitedApi(agentIdRaw: unknown): boolean {
  return !apiRateLimiter.tryConsume(rateLimitKey(agentIdRaw))
}

type Json = Record<string, unknown>

interface ControlDeps {
  core: Core
  terminals: TerminalManager
  planner: PlannerStore
  orchestration: OrchestrationStore
  canvas: CanvasStore
  state: AppState
  defaultCwd(): string | undefined

  port?: number

  socketPath?: string

  rendererDir?: string
  broadcast?(channel: string, payload: unknown): void


  capture?(widgetId?: string): Promise<{ name: string; path: string } | { error: string }>

  onPortAssigned?(port: number): void

  onSocketAssigned?(socketPath: string): void
}


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





export function startControlServer(deps: ControlDeps): http.Server {
  const token = controlToken()
  const socketPath = deps.socketPath ?? getIpcSocketPath()
  prepareSocketPath(socketPath)

  // Returns whether the request was answered, mirroring the route handlers.
  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): unknown => {
    applyLoopbackCors(req, res, `Content-Type, ${CONTROL_TOKEN_HEADER}`)
    const url = new URL(req.url || '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method || 'GET'

    if (deps.rendererDir && (method === 'GET' || method === 'HEAD') && isRendererPath(url.pathname)) {
      return serveRendererFile(deps.rendererDir, url.pathname, res, method === 'HEAD')
    }


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
        buildPresence({ workspaceDir: deps.defaultCwd() ?? null, socketPath })
      )
    }

    if (!isTrustedCaller(req, token)) {
      // When the token could not be written, every caller that reads it from
      // disk lands here, and "a valid control token is required" is a dead
      // end. Name the real cause instead.
      const unwritable = controlTokenPersistError()
      return sendJson(res, 401, {
        error: unwritable
          ? `the control token could not be written to disk, so no client can read it: ${unwritable}`
          : 'a valid control token is required'
      })
    }
    void route(req, res, deps).catch((err) => {
      console.error('control request failed', err)
      if (!res.headersSent) {
        if (err instanceof URIError) return sendJson(res, 400, { error: 'invalid URL encoding' })
        const raw = (err as { statusCode?: unknown })?.statusCode
        const status2 = typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw <= 599 ? (raw as number) : 500
        const message = status2 >= 500 ? 'internal error' : err instanceof Error ? err.message : String(err)
        sendJson(res, status2, { error: message })
      }
    })
  }


  const pipeServer = http.createServer(handleRequest)
  let activeSocket = socketPath
  pipeServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const fallback = process.platform === 'win32'
        ? `\\\\.\\pipe\\orcspace-${process.pid}`
        : join(os.tmpdir(), `orcspace-${process.pid}.sock`)
      console.warn(`control IPC socket ${activeSocket} in use, falling back to ${fallback}`)
      prepareSocketPath(fallback)
      activeSocket = fallback
      pipeServer.listen(fallback, () => {
        setActiveSocketPath(fallback)
        deps.onSocketAssigned?.(fallback)
      })
      return
    }
    console.error('control pipe server error', err)
  })
  pipeServer.listen(socketPath, () => {
    setActiveSocketPath(socketPath)
    deps.onSocketAssigned?.(socketPath)
  })


  const shouldListenTcp = deps.port !== undefined || Boolean(process.env.WORKSPACE_CONTROL_PORT)
  if (!shouldListenTcp) {
    return pipeServer
  }

  const tcpPort = deps.port ?? (Number(process.env.WORKSPACE_CONTROL_PORT) || CONTROL_PORT)
  let activePort = tcpPort
  const tcpServer = http.createServer(handleRequest)

  tcpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `control port ${activePort} is already in use — falling back to an available free port on 127.0.0.1.`
      )
      tcpServer.listen(0, '127.0.0.1', () => {
        const address = tcpServer.address()
        const assigned = typeof address === 'object' && address ? address.port : 0
        if (assigned) {
          activePort = assigned
          setActiveControlPort(assigned)
          console.log(`control server fallback listening on http://127.0.0.1:${assigned}`)
          deps.onPortAssigned?.(assigned)
        }
      })
      return
    }
    console.error('control tcp server error', err)
  })

  tcpServer.listen(tcpPort, '127.0.0.1', () => {
    setActiveControlPort(tcpPort)
    console.log(`control server listening on http://127.0.0.1:${tcpPort}`)
    deps.onPortAssigned?.(tcpPort)
  })

  const originalClose = tcpServer.close.bind(tcpServer)
  tcpServer.close = (cb?: (err?: Error) => void) => {
    try {
      pipeServer.close()
    } catch {}
    return originalClose(cb)
  }
  const originalCloseAll = tcpServer.closeAllConnections?.bind(tcpServer)
  if (originalCloseAll) {
    tcpServer.closeAllConnections = () => {
      try {
        pipeServer.closeAllConnections?.()
      } catch {}
      return originalCloseAll()
    }
  }

  return tcpServer
}

function isRendererPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html' || pathname.startsWith('/assets/')
}

function serveRendererFile(rendererDir: string, pathname: string, res: http.ServerResponse, head: boolean): void {
  let relative: string
  try {



    const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    relative = normalize(decoded).replace(/^[/\\]+/, '')
  } catch {
    res.writeHead(400).end(); return
  }


  const resolved = resolve(rendererDir, relative)
  const lowerResolved = resolved.toLowerCase()
  const lowerDir = rendererDir.toLowerCase()
  if (!lowerResolved.startsWith(lowerDir + sep.toLowerCase()) && lowerResolved !== lowerDir) {
    res.writeHead(403).end(); return
  }
  const filePath = resolved
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) { res.writeHead(404).end(); return }
    if (stat.size > 20 * 1024 * 1024) { res.writeHead(413).end(); return }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': rendererMime[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
      if (head) res.end(); else res.end(data)
    })
  })
}

const rendererMime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8'
}

function isTrustedCaller(req: http.IncomingMessage, token: string): boolean {
  if (!isLoopbackRequest(req)) return false
  const presented = req.headers[CONTROL_TOKEN_HEADER]
  return typeof presented === 'string' && secretsEqual(presented, token)
}


const RESERVED_ACTOR_IDS = new Set(['user', 'assistant', 'system'])

function registerHttpAgent(
  core: Core,
  agentIdRaw: unknown
): { ok: true; agentId: string } | { ok: false; status: number; error: string; code: CommandErrorCode } {
  const agentId = String(agentIdRaw ?? '').trim()
  if (!agentId) {
    return { ok: false, status: 401, error: 'agentId is required', code: 'unknown_actor' }
  }
  if (agentId.length > 128) {
    return {
      ok: false,
      status: 400,
      error: 'agentId must be 1–128 chars',
      code: 'invalid'
    }
  }

  if (!/^[A-Za-z0-9._@-]+$/.test(agentId)) {
    return {
      ok: false,
      status: 400,
      error: 'agentId must be [A-Za-z0-9._@-] only',
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

async function route(req: http.IncomingMessage, res: http.ServerResponse, deps: ControlDeps): Promise<unknown> {
  const url = new URL(req.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  const method = req.method || 'GET'
  const { terminals, planner, canvas, core } = deps

  // Charged to the caller that named itself, so one agent's runaway loop can
  // only throttle that agent.
  if (rateLimitedApi(url.searchParams.get('agentId') ?? req.headers['x-agent-id'])) {
    return sendJson(res, 429, { error: 'too many requests', code: 'rate_limited' })
  }

  const submit = async <T>(
    body: Json,
    type: string,
    target: string,
    payload: unknown,
    _options: { actorType?: ActorType } = {}
  ): Promise<CommandResult<T>> => {
    const rawAgentId = body.agentId ?? url.searchParams.get('agentId') ?? req.headers['x-agent-id']
    const registered = registerHttpAgent(core, rawAgentId)
    if (!registered.ok) {
      return { ok: false, code: registered.code, message: registered.error }
    }
    core.locks.heartbeat(registered.agentId)
    const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : undefined
    return core.flow.submit<T>({ actorId: registered.agentId, type, target, payload, baseVersion })
  }

  const reply = <T>(result: CommandResult<T>, okStatus = 200): true => {
    if (result.ok) return sendJson(res, okStatus, { ok: true, version: result.version, seq: result.seq, data: result.data })
    return sendJson(res, STATUS_BY_CODE[result.code] ?? 400, {
      error: result.message,
      code: result.code,
      ...result.details
    })
  }



  if (method === 'GET' && parts[0] === 'workspace' && parts[1] === 'code') {
    const stateWithCode = deps.state as AppState & { codeWorkspaceState?: (folder?: string) => unknown }
    return sendJson(res, 200, stateWithCode.codeWorkspaceState
      ? stateWithCode.codeWorkspaceState(deps.defaultCwd())
      : { workspaces: [], activeId: null, folder: deps.defaultCwd() ?? null })
  }


  if (method === 'GET' && (parts.length === 0 || parts[0] === 'health')) {
    return sendJson(res, 200, {
      ok: true,
      app: 'orcspace',
      server: 'orcspace-control',
      version: APP_VERSION,
      controlPort: getActiveControlPort(),
      workspaceDir: deps.defaultCwd() ?? null,
      terminals: terminals.list().length,
      commands: core.flow.types()
    })
  }


  if (method === 'GET' && parts[0] === 'snapshot') {
    const plannerItems = planner.list()
    const shells = terminals.list().map((t) => ({ ...t, kind: 'terminal' as const }))
    const others = canvas
      .listWidgets()
      .filter((w) => w.kind !== 'terminal')
      .map((w) => ({ id: w.id, title: w.title, kind: w.kind, version: w.version }))
    const sinceRaw = Number(url.searchParams.get('since') || Math.max(0, core.journal.lastSeq - 40))
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : Math.max(0, core.journal.lastSeq - 40)
    return sendJson(
      res,
      200,
      buildSnapshot({
        workspaceDir: deps.defaultCwd() ?? null,
        terminals: shells,
        widgets: [...shells, ...others],
        locks: core.locks.list(),
        plannerItems,
        journal: { lastSeq: core.journal.lastSeq, entries: core.journal.since(since) },
        commands: core.flow.types(),
      })
    )
  }


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


  if (parts[0] === 'git') {
    const body = method === 'GET' ? {} : await readJson(req)
    if (method === 'GET' && parts[1] === 'status') {
      core.actors.register({ id: 'system', type: 'system', label: 'OrcSpace', transport: 'internal' })
      return reply(await core.flow.submit({ actorId: 'system', type: 'git.refresh', target: GIT_TARGET, payload: {} }))
    }
    if (method === 'POST' && parts[1] === 'commit') {
      return reply(await submit(body, 'git.commit', GIT_TARGET, { message: body.message }))
    }
  }


  if (method === 'GET' && parts[0] === 'journal') {
    const sinceRaw = Number(url.searchParams.get('since') || 0)
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0
    return sendJson(res, 200, { lastSeq: core.journal.lastSeq, entries: core.journal.since(since) })
  }


  const ctx: DomainContext = { req, res, url, parts, method, deps, submit, reply }

  if (await routeOrchestration(ctx)) return true

  if (await routePlanner(ctx)) return true

  if (await routeCanvas(ctx)) return true


  sendJson(res, 404, { error: 'not found' })
}

/**
 * Image paths on a request body, from either `image` or `images`.
 *
 * The control API is local — the CLI and the app share a filesystem — so an
 * attachment travels as a path rather than as bytes on the wire.
 */
/**
 * One domain's routes.
 *
 * `route()` had grown to 621 lines matching thirteen domains in sequence, so
 * the three largest are functions now. Each returns whether it answered the
 * request; falling out of the bottom means "not mine", and the next domain
 * gets a look.
 *
 * The bodies are the originals, unchanged. They keep working because
 * `sendJson` and `reply` report `true`, so every branch that already ended in
 * `return sendJson(...)` now also reports that it handled the request — the
 * handled/not-handled signal cannot drift out of step with the response,
 * because it *is* the response.
 */
interface DomainContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  parts: string[]
  method: string
  deps: ControlDeps
  submit<T>(body: Json, type: string, target: string, payload: unknown): Promise<CommandResult<T>>
  reply<T>(result: CommandResult<T>, okStatus?: number): true
}

async function routeOrchestration(ctx: DomainContext): Promise<boolean> {
  const { req, res, url, parts, method, deps, submit, reply } = ctx
  const { terminals, canvas, core, orchestration } = ctx.deps
  if (parts[0] === 'orchestration') {
    const runIdParam = url.searchParams.get('runId') || undefined
    const callerId = (): { ok: true; agentId: string } | { ok: false; status: number; error: string; code: CommandErrorCode } =>
      registerHttpAgent(core, url.searchParams.get('agentId') ?? req.headers['x-agent-id'])


    if (method === 'GET' && parts.length === 1) {
      return sendJson(res, 200, orchestration.snapshot(runIdParam))
    }
    if (method === 'GET' && parts[1] === 'runs') {
      if (parts[2]) {
        const runId = decodeURIComponent(parts[2])
        try {
          const run = orchestration.requireRun(runId)
          return sendJson(res, 200, { run })
        } catch (err) {
          return sendJson(res, 404, { error: (err as Error).message })
        }
      }
      return sendJson(res, 200, { runs: orchestration.listRuns(), active: orchestration.activeRun() ?? null })
    }
    if (method === 'GET' && parts[1] === 'tasks') {
      if (parts[2]) {
        const taskId = decodeURIComponent(parts[2])
        try {
          const task = orchestration.requireTask(taskId)
          return sendJson(res, 200, { task })
        } catch (err) {
          return sendJson(res, 404, { error: (err as Error).message })
        }
      }
      const status = url.searchParams.get('status') || undefined
      if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) {
        return sendJson(res, 400, { error: `unknown task status "${status}"`, code: 'invalid' })
      }
      return sendJson(res, 200, {
        tasks: orchestration.listTasks({
          runId: runIdParam,
          status: status as never,
          ready: url.searchParams.get('ready') === '1'
        })
      })
    }
    if (method === 'GET' && parts[1] === 'messages' && parts[2]) {
      const msgId = decodeURIComponent(parts[2])
      const msg = orchestration.messageById(msgId)
      if (!msg) return sendJson(res, 404, { error: `no message "${msgId}"` })
      return sendJson(res, 200, { message: msg })
    }
    if (method === 'GET' && parts[1] === 'dispatches') {
      if (parts[2]) {
        const dispId = decodeURIComponent(parts[2])
        try {
          const dispatch = orchestration.requireDispatch(dispId)
          return sendJson(res, 200, { dispatch })
        } catch (err) {
          return sendJson(res, 404, { error: (err as Error).message })
        }
      }
      return sendJson(res, 200, {
        dispatches: orchestration.listDispatches({
          runId: runIdParam,
          taskId: url.searchParams.get('taskId') || undefined
        }),
        unaccounted: orchestration.unaccountedDispatches(runIdParam).map((d) => d.id)
      })
    }
    if (method === 'GET' && parts[1] === 'gates') {
      if (parts[2]) {
        const gateId = decodeURIComponent(parts[2])
        try {
          const gate = orchestration.requireGate(gateId)
          return sendJson(res, 200, { gate })
        } catch (err) {
          return sendJson(res, 404, { error: (err as Error).message })
        }
      }
      return sendJson(res, 200, {
        gates: orchestration.listGates({ runId: runIdParam, open: url.searchParams.get('open') === '1' })
      })
    }


    if (parts[1] === 'workers') {
      const registered = callerId()
      const caller = registered.ok ? registered.agentId : undefined

      if (method === 'GET' && parts.length === 2) {
        return sendJson(res, 200, { workers: listWorkers({ terminals, orchestration }, caller) })
      }

      if (method === 'POST' && (parts[2] === 'tell' || parts[2] === 'rename')) {
        const body = await readJson(req)
        const bodyAgent = typeof body.agentId === 'string' && body.agentId ? body.agentId : undefined
        const effectiveCaller = bodyAgent ?? caller
        let worker: ReturnType<typeof resolveWorker>
        try {
          worker = resolveWorker({ terminals, orchestration }, String(body.to ?? ''), effectiveCaller)
        } catch (err) {
          const code = (err as { code?: CommandErrorCode }).code ?? 'invalid'
          return sendJson(res, STATUS_BY_CODE[code] ?? 400, { error: (err as Error).message, code })
        }

        if (parts[2] === 'rename') {
          const title = String(body.name ?? '').trim().slice(0, 200)
          if (!title) return sendJson(res, 400, { error: 'name must not be empty', code: 'invalid' })
          if (!canvas.widget(worker.id) && terminals.has(worker.id)) {
            terminals.setTitle(worker.id, title)
            deps.broadcast?.('control:rename-widget', { id: worker.id, title })
            return sendJson(res, 200, { ok: true, id: worker.id, name: title })
          }
          const result = await submit(body, 'widget.update', `widget:${worker.id}`, { title })
          if (result.ok) return sendJson(res, 200, { ok: true, id: worker.id, name: String(body.name ?? '') })
          return reply(result)
        }

        const images = imageList(body)
        if (images.length > 0) {
          return reply(
            await submit(body, 'terminal.attach', `terminal:${worker.id}`, {
              images,
              text: String(body.text ?? ''),
              pressEnter: body.pressEnter !== false,
              confirmDelivery: body.confirmDelivery === true,
              deliveryTimeoutMs: typeof body.deliveryTimeoutMs === 'number' ? body.deliveryTimeoutMs : undefined
            })
          )
        }

        return reply(
          await submit(body, 'terminal.write', `terminal:${worker.id}`, {
            text: String(body.text ?? ''),
            pressEnter: body.pressEnter !== false,
            confirmDelivery: true,
            deliveryTimeoutMs: typeof body.deliveryTimeoutMs === 'number' ? body.deliveryTimeoutMs : undefined
          })
        )
      }
    }


    if (method === 'GET' && parts[1] === 'inbox') {
      const registered = callerId()
      if (!registered.ok) return sendJson(res, registered.status, { error: registered.error, code: registered.code })
      const types = (url.searchParams.get('types') || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      for (const type of types) {
        if (!(MESSAGE_TYPES as readonly string[]).includes(type)) {
          return sendJson(res, 400, { error: `unknown message type "${type}"`, code: 'invalid' })
        }
      }
      const filter = {
        runId: runIdParam,
        types: types.length ? (types as MessageType[]) : undefined,
        includeAcked: url.searchParams.get('all') === '1',
        limit: clampInt(url.searchParams.get('limit'), 50, 1, 200)
      }
      const immediate = orchestration.inbox(registered.agentId, filter)
      if (immediate.length > 0 || url.searchParams.get('wait') !== '1') {
        return sendJson(res, 200, { messages: immediate, waited: false })
      }
      const inboxWait = await waitForInbox(
        orchestration,
        registered.agentId,
        filter,
        clampInt(url.searchParams.get('timeoutMs'), 900_000, 1_000, 3_600_000),
        req
      )
      return sendJson(res, 200, { messages: inboxWait.messages, waited: !inboxWait.overloaded })
    }


    if (method === 'GET' && parts[1] === 'replies' && parts[2]) {
      const askId = decodeURIComponent(parts[2])
      if (!orchestration.messageById(askId)) {
        return sendJson(res, 404, { error: `no message "${askId}"`, code: 'not_found' })
      }
      const existing = orchestration.replyTo(askId)
      if (existing || url.searchParams.get('wait') !== '1') {
        return sendJson(res, 200, { reply: existing ?? null, waited: false })
      }
      const replyWait = await waitForReply(
        orchestration,
        askId,
        clampInt(url.searchParams.get('timeoutMs'), 600_000, 1_000, 3_600_000),
        req
      )
      return sendJson(res, 200, { reply: replyWait.reply ?? null, waited: !replyWait.overloaded })
    }


    if (method === 'POST' && parts[1] === 'runs' && parts.length === 2) {
      const body = await readJson(req)
      return reply(await submit(body, 'run.create', NEW.run, body), 201)
    }
    if (method === 'POST' && parts[1] === 'runs' && parts[3] === 'close') {
      const body = await readJson(req)
      return reply(await submit(body, 'run.close', `run:${decodeURIComponent(parts[2])}`, {}))
    }
    if (method === 'POST' && parts[1] === 'tasks' && parts.length === 2) {
      const body = await readJson(req)
      let images: string[]
      try {
        images = importImages(imageList(body))
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err), code: 'invalid' })
      }
      return reply(await submit(body, 'orctask.create', NEW.orctask, { ...body, images }), 201)
    }
    if (method === 'PATCH' && parts[1] === 'tasks' && parts[2]) {
      const body = await readJson(req)
      return reply(await submit(body, 'orctask.update', `orctask:${decodeURIComponent(parts[2])}`, body))
    }
    if (method === 'POST' && parts[1] === 'dispatches' && parts.length === 2) {
      const body = await readJson(req)
      return reply(await submit(body, 'dispatch.start', NEW.dispatch, body), 201)
    }
    if (method === 'POST' && parts[1] === 'dispatches' && parts[3] === 'settle') {
      const body = await readJson(req)
      const result = await submit(body, 'dispatch.settle', `dispatch:${decodeURIComponent(parts[2])}`, body)
      if (result.ok) {
        try {
          const data = result.data as { dispatchId: string; taskId: string; status: string }
          const dispatch = orchestration.requireDispatch(data.dispatchId)
          const from = typeof body.agentId === 'string' && body.agentId ? body.agentId : 'api'
          orchestration.send({
            runId: dispatch.runId,
            type: 'worker_done',
            from,
            to: dispatch.terminalId,
            subject: `worker_done ${dispatch.taskId}`,
            body: `dispatch ${dispatch.id} settled as ${data.status} via API`,
            taskId: dispatch.taskId,
            dispatchId: dispatch.id
          })
        } catch {

        }
      }
      return reply(result)
    }
    if (method === 'POST' && parts[1] === 'dispatches' && parts[3] === 'account') {
      const body = await readJson(req)
      return reply(await submit(body, 'dispatch.account', `dispatch:${decodeURIComponent(parts[2])}`, body))
    }
    if (method === 'POST' && parts[1] === 'messages' && parts.length === 2) {
      const body = await readJson(req)
      let images: string[]
      try {
        images = importImages(imageList(body))
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err), code: 'invalid' })
      }
      return reply(await submit(body, 'orc.send', runTarget(body.runId), { ...body, images }), 201)
    }
    if (method === 'POST' && parts[1] === 'messages' && parts[3] === 'ack') {
      const body = await readJson(req)
      return reply(await submit(body, 'orc.ack', runTarget(body.runId), { messageId: decodeURIComponent(parts[2]) }))
    }
    if (method === 'POST' && parts[1] === 'gates' && parts.length === 2) {
      const body = await readJson(req)
      return reply(await submit(body, 'gate.create', NEW.gate, body), 201)
    }
    if (method === 'POST' && parts[1] === 'gates' && parts[3] === 'resolve') {
      const body = await readJson(req)
      return reply(await submit(body, 'gate.resolve', `gate:${decodeURIComponent(parts[2])}`, body))
    }
    if (method === 'POST' && parts[1] === 'reset') {
      const body = await readJson(req)
      const registered = registerHttpAgent(core, body.agentId)
      if (!registered.ok) return sendJson(res, registered.status, { error: registered.error, code: registered.code })
      orchestration.reset({ tasks: body.tasks === true, messages: body.messages === true, all: body.all === true })
      return sendJson(res, 200, { ok: true })
    }
  }
  return false
}

async function routePlanner(ctx: DomainContext): Promise<boolean> {
  const { req, res, parts, method, submit, reply } = ctx
  const { planner } = ctx.deps
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
  return false
}

async function routeCanvas(ctx: DomainContext): Promise<boolean> {
  const { req, res, url, parts, method, deps, submit, reply } = ctx
  const { terminals, canvas, orchestration } = ctx.deps
  if (method === 'GET' && parts[0] === 'widgets' && parts.length === 1) {
    const others = canvas
      .listWidgets()
      .filter((w) => w.kind !== 'terminal')
      .map((w) => ({ id: w.id, title: w.title, kind: w.kind, version: w.version }))
    const shells = terminals.list().map((t) => ({ ...t, kind: 'terminal' as const }))
    return sendJson(res, 200, { widgets: [...shells, ...others] })
  }

  if (method === 'POST' && ((parts[0] === 'widgets' && parts[1] === 'terminal') || (parts[0] === 'terminal' && parts.length === 1))) {
    const body = await readJson(req)
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : undefined
    const cwd = typeof body.cwd === 'string' ? body.cwd.slice(0, 1024) : undefined
    return reply(
      await submit(body, 'terminal.create', NEW.terminal, {
        title: title || undefined,
        cwd,
        agentOwned: true
      })
    )
  }

  if (method === 'DELETE' && (parts[0] === 'widgets' || parts[0] === 'terminal') && parts[1]) {
    const rawId = safeDecode(parts[1])
    if (!rawId || !/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) return sendJson(res, 400, { error: 'invalid id' })
    const id = rawId
    const body = await readJson(req)
    if (terminals.has(id)) return reply(await submit(body, 'terminal.dispose', `terminal:${id}`, {}))
    return reply(await submit(body, 'widget.remove', `widget:${id}`, {}))
  }

  if (method === 'POST' && parts[0] === 'widgets' && parts.length === 1) {
    const body = await readJson(req)
    return reply(await submit(body, 'widget.create', NEW.widget, body), 201)
  }

  if (method === 'PATCH' && parts[0] === 'widgets' && parts[1]) {
    const rawId = safeDecode(parts[1])
    if (!rawId || !/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) return sendJson(res, 400, { error: 'invalid id' })
    const body = await readJson(req)
    return reply(await submit(body, 'widget.update', `widget:${rawId}`, body))
  }

  if (method === 'POST' && parts[0] === 'canvas' && parts[1] === 'camera') {
    const body = await readJson(req)
    return reply(await submit(body, 'canvas.camera', CANVAS_TARGET, body))
  }

  if (method === 'POST' && parts[0] === 'terminal' && parts[2] === 'attach') {
    const rawId = safeDecode(parts[1])
    if (!rawId || !/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) return sendJson(res, 400, { error: 'invalid terminal id' })
    const body = await readJson(req)
    return reply(
      await submit(body, 'terminal.attach', `terminal:${rawId}`, {
        images: imageList(body),
        text: typeof body.text === 'string' ? body.text : '',
        pressEnter: body.pressEnter !== false,
        confirmDelivery: body.confirmDelivery === true,
        deliveryTimeoutMs: typeof body.deliveryTimeoutMs === 'number' ? body.deliveryTimeoutMs : undefined
      })
    )
  }

  if (method === 'POST' && parts[0] === 'canvas' && parts[1] === 'media') {
    const body = await readJson(req)
    const source = String(body.path ?? body.image ?? body.file ?? '').trim()
    if (!source) return sendJson(res, 400, { error: 'canvas media needs a file path', code: 'invalid' })
    if (!isLocalPath(source)) {
      return sendJson(res, 400, { error: `path must be absolute and local: ${source}`, code: 'invalid' })
    }
    let file: { name: string; path: string }
    try {
      file = importFile(source)
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err), code: 'invalid' })
    }
    const created = await submit<{ id: string; title: string }>(body, 'widget.create', NEW.widget, {
      kind: 'browser',
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : basename(source),
      x: typeof body.x === 'number' ? body.x : undefined,
      y: typeof body.y === 'number' ? body.y : undefined
    })
    if (!created.ok) return reply(created)
    deps.broadcast?.('control:open-media', {
      widgetId: created.data.id,
      path: file.path,
      name: basename(source),
      mediaUrl: `orc://media/${file.name}`,
      kind: mediaKindOf(source)
    })
    return sendJson(res, 201, {
      ok: true,
      data: { id: created.data.id, title: created.data.title, path: file.path, kind: mediaKindOf(source) }
    })
  }

  if (method === 'POST' && parts[0] === 'screenshot') {
    const body = await readJson(req)
    if (!deps.capture) return sendJson(res, 503, { error: 'screen capture is unavailable', code: 'failed' })
    const raw = String(body.worker ?? body.target ?? '').trim()
    let widgetId: string | undefined
    if (raw) {
      try {
        widgetId = resolveWorker({ terminals, orchestration }, raw, undefined).id
      } catch (err) {
        const code = (err as { code?: CommandErrorCode }).code ?? 'invalid'
        return sendJson(res, STATUS_BY_CODE[code] ?? 400, { error: (err as Error).message, code })
      }
    }
    const shot = await deps.capture(widgetId)
    if ('error' in shot) return sendJson(res, 500, { error: shot.error, code: 'failed' })
    return sendJson(res, 200, { ok: true, data: { path: shot.path, name: shot.name, ...(widgetId ? { widgetId } : {}) } })
  }

  if (method === 'POST' && parts[0] === 'terminal' && parts[2] === 'write') {
    const rawId = safeDecode(parts[1])
    if (!rawId || !/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) return sendJson(res, 400, { error: 'invalid terminal id' })
    const id = rawId
    const body = await readJson(req)
    const text = typeof body.text === 'string' ? body.text : ''


    if (Buffer.byteLength(text, 'utf8') > MAX_TERMINAL_WRITE_BYTES) {
      return sendJson(res, 413, { error: `write exceeds ${MAX_TERMINAL_WRITE_BYTES} bytes` })
    }
    return reply(
      await submit(body, 'terminal.write', `terminal:${id}`, {
        text,
        pressEnter: body.pressEnter !== false,
        confirmDelivery: body.confirmDelivery !== false,
        deliveryTimeoutMs: typeof body.deliveryTimeoutMs === 'number' ? body.deliveryTimeoutMs : undefined
      })
    )
  }

  if (method === 'GET' && parts[0] === 'terminal' && parts[2] === 'output') {
    const rawId = safeDecode(parts[1])
    let id = rawId
    if (id && !terminals.has(id)) {
      const exact = listWorkers({ terminals, orchestration }, undefined).find((w) => w.id === id || w.name === id)
      if (exact) id = exact.id
    }
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return sendJson(res, 400, { error: 'invalid terminal id' })
    if (url.searchParams.get('full') === '1') {
      const output = terminals.fullOutput(id)
      if (output === null) return sendJson(res, 404, { error: 'terminal not found' })
      return sendJson(res, 200, { output })
    }
    const output = terminals.readOutput(id, url.searchParams.get('clear') === '1')
    if (output === null) return sendJson(res, 404, { error: 'terminal not found' })
    return sendJson(res, 200, { output })
  }
  return false
}

function imageList(body: Json): string[] {
  const raw = Array.isArray(body.images) ? body.images : []
  const single = typeof body.image === 'string' ? [body.image] : []
  return [...raw, ...single]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0)
    .slice(0, 8)
}

/**
 * Copy every attachment into the media store, so a path in mail or a task
 * spec still resolves long after the command that sent it.
 */
function importImages(paths: string[]): string[] {
  return paths.map((path) => resolveImage(path).path)
}

function mediaKindOf(path: string): 'image' | 'video' | 'audio' | 'pdf' | 'doc' {
  if (hasImageExtension(path)) return 'image'
  if (hasVideoExtension(path)) return 'video'
  if (hasAudioExtension(path)) return 'audio'
  if (path.toLowerCase().endsWith('.pdf')) return 'pdf'
  if (hasDocExtension(path)) return 'doc'
  return 'doc'
}

function runTarget(runId: unknown): string {
  const id = String(runId ?? '').trim()
  if (!id) return NEW.run


  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw Object.assign(new Error('invalid runId'), { statusCode: 400 })
  }
  return `run:${id}`
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}


function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}


let activeWaiters = 0
const MAX_WAITERS = 50

function overloadedWaiters(): boolean {
  return activeWaiters >= MAX_WAITERS
}

function waitForInbox(
  orchestration: OrchestrationStore,
  agentId: string,
  filter: { runId?: string; types?: MessageType[]; includeAcked?: boolean; limit?: number },
  timeoutMs: number,
  req: http.IncomingMessage
): Promise<{ messages: unknown[]; overloaded: boolean }> {


  if (overloadedWaiters()) return Promise.resolve({ messages: orchestration.inbox(agentId, filter), overloaded: true })
  activeWaiters += 1
  return new Promise((resolve) => {
    let done = false
    const finish = (value: unknown[]): void => {
      if (done) return
      done = true
      activeWaiters = Math.max(0, activeWaiters - 1)
      clearTimeout(timer)
      orchestration.off('message', onMessage)
      req.off('close', onClose)
      resolve({ messages: value, overloaded: false })
    }
    const onMessage = (message?: { runId?: string; type?: MessageType }): void => {
      if (message) {
        if (filter.runId && message.runId !== filter.runId) return
        if (filter.types?.length && message.type && !filter.types.includes(message.type)) return
      }
      const found = orchestration.inbox(agentId, filter)
      if (found.length > 0) finish(found)
    }
    const onClose = (): void => finish([])
    const timer = setTimeout(() => finish([]), timeoutMs)
    timer.unref?.()
    orchestration.on('message', onMessage)
    req.on('close', onClose)
    onMessage()
  })
}

function waitForReply(
  orchestration: OrchestrationStore,
  askId: string,
  timeoutMs: number,
  req: http.IncomingMessage
): Promise<{ reply: unknown; overloaded: boolean }> {
  if (overloadedWaiters()) return Promise.resolve({ reply: orchestration.replyTo(askId) ?? null, overloaded: true })
  activeWaiters += 1
  return new Promise((resolve) => {
    let done = false
    const finish = (value: unknown): void => {
      if (done) return
      done = true
      activeWaiters = Math.max(0, activeWaiters - 1)
      clearTimeout(timer)
      orchestration.off('message', onMessage)
      req.off('close', onClose)
      resolve({ reply: value, overloaded: false })
    }
    const onMessage = (): void => {
      const found = orchestration.replyTo(askId)
      if (found) finish(found)
    }
    const onClose = (): void => finish(null)
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    orchestration.on('message', onMessage)
    req.on('close', onClose)
    onMessage()
  })
}

function readJson(req: http.IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const fail = (statusCode: number, message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      req.resume()
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
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'), (k: string, v: unknown) =>
          k === '__proto__' || k === 'prototype' || k === 'constructor' ? undefined : v
        )
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

function normalizeLockResource(raw: unknown): string {
  const text = String(raw ?? '').trim()
  const parsed = parseResource(text)
  if (parsed?.scheme === 'file') return fileResource(parsed.id)
  if (/^[A-Za-z]:[\\/]/.test(text) || text.includes('\\') || text.startsWith('/')) return fileResource(text)
  return text
}

/**
 * Writes a JSON response and reports that the request was handled.
 *
 * The `true` is what lets each route domain be a function that returns whether
 * it answered: every branch already ends in `return sendJson(...)`, so the
 * handled/not-handled decision needs no extra bookkeeping and cannot drift out
 * of step with the response.
 */
function sendJson(res: http.ServerResponse, status: number, data: unknown): true {
  if (res.headersSent || res.destroyed || res.writableEnded) return true
  const body = JSON.stringify(data)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    })
    res.end(body)
  } catch {

  }
  return true
}

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
