import * as http from 'http'
import { CONTROL_PORT, MCP_PORT, MCP_SERVER_NAME, mcpUrl } from './config'
import { CoordinationStore, Forbidden, USER_AUTHOR } from './coordination'
import { TerminalManager } from './terminals'
import { BrainStore } from './brain'
import { CanvasState } from './canvasState'

type Json = Record<string, unknown>

interface ControlDeps {
  terminals: TerminalManager
  coordination: CoordinationStore
  brain: BrainStore
  canvas: CanvasState
  /** Asks the renderer to mount a widget for an already-reserved terminal id. */
  requestWidget(info: { id: string; title: string }): void
  requestWidgetRemoval(id: string): void
  defaultCwd(): string | undefined
  /** Reports whether the bundled MCP server process is currently up. */
  mcpRunning(): boolean
}

/**
 * Loopback-only HTTP surface that the MCP server (and any local tooling) drives
 * the app through. Bound to 127.0.0.1 so it is never reachable off the machine.
 */
export function startControlServer(deps: ControlDeps): http.Server {
  const server = http.createServer((req, res) => {
    if (!isTrustedCaller(req)) {
      return sendJson(res, 403, { error: 'cross-origin requests are not accepted' })
    }
    void route(req, res, deps).catch((err) => {
      console.error('control request failed', err)
      if (!res.headersSent) sendJson(res, 500, { error: String(err) })
    })
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `control port ${CONTROL_PORT} is already in use — another Workspace instance is probably running.`
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
 * Binding to loopback keeps the network out, but not the browser: any page the
 * user visits can POST to 127.0.0.1 from JavaScript, and this API opens shells
 * and types into them. Browsers attach `Origin` to exactly those cross-site
 * requests, so refusing any non-local `Origin` closes the hole while leaving
 * local tooling — which sends no `Origin` at all — untouched. `Host` is checked
 * for the same reason: it blocks a DNS-rebinding domain resolving to 127.0.0.1.
 * The `Origin: null` sent by sandboxed iframes (and redirects) is rejected too:
 * a page that only managed to smuggle its request through a sandboxed frame
 * must not get loopback access just because its origin serializes to `null`.
 */
function isTrustedCaller(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && !isLoopbackUrl(origin)) return false
  const host = req.headers.host
  if (typeof host === 'string' && host && !isLoopbackHost(host)) return false
  return true
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

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ControlDeps
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  const method = req.method || 'GET'
  const { terminals, coordination, brain, canvas } = deps

  try {
    // ---- health ----------------------------------------------------------
    // Lets the MCP panel (and any client) confirm the app is actually up
    // before blaming the transport for a failed tool call.
    if (method === 'GET' && (parts.length === 0 || parts[0] === 'health')) {
      return sendJson(res, 200, {
        ok: true,
        app: 'workspace',
        server: MCP_SERVER_NAME,
        controlPort: CONTROL_PORT,
        mcpPort: MCP_PORT,
        mcpUrl: mcpUrl(MCP_PORT),
        mcpRunning: deps.mcpRunning(),
        workspaceDir: deps.defaultCwd() ?? null,
        terminals: terminals.list().length,
        managerId: coordination.managerId
      })
    }

    // ---- second brain ----------------------------------------------------
    if (parts[0] === 'brain') {
      if (method === 'GET' && parts.length === 1) return sendJson(res, 200, brain.snapshot())
      if (method === 'GET' && parts[1] === 'search') return sendJson(res, 200, { notes: brain.search(url.searchParams.get('q') || '') })
      if (method === 'POST' && parts.length === 1) return sendJson(res, 201, { note: brain.create(await readJson(req)) })
      if (method === 'PATCH' && parts[1]) return sendJson(res, 200, { note: brain.update(decodeURIComponent(parts[1]), await readJson(req)) })
      if (method === 'DELETE' && parts[1]) { brain.remove(decodeURIComponent(parts[1])); return sendJson(res, 200, { ok: true }) }
    }
    // ---- coordination -----------------------------------------------------
    if (parts[0] === 'coordination') {
      if (method === 'GET' && parts[1] === 'status') return sendJson(res, 200, coordination.snapshot())
      if (method === 'GET' && parts[1] === 'tasks') return sendJson(res, 200, { tasks: coordination.snapshot().tasks })

      if (method === 'POST' && parts[1] === 'manager') {
        const body = await readJson(req)
        return sendJson(res, 200, coordination.claimManager(String(body.agentId ?? '')))
      }
      if (method === 'DELETE' && parts[1] === 'manager') {
        const body = await readJson(req)
        coordination.releaseManager(String(body.agentId ?? ''))
        return sendJson(res, 200, { ok: true })
      }
      if (method === 'POST' && parts[1] === 'tasks' && parts.length === 2) {
        const body = await readJson(req)
        if (!coordination.isManager(body.agentId)) throw new Forbidden('only the manager may create tasks')
        return sendJson(res, 201, {
          task: coordination.createTask({ ...body, title: String(body.title ?? ''), createdBy: String(body.agentId) })
        })
      }
      if (method === 'POST' && parts[1] === 'tasks' && parts[3] === 'claim') {
        const body = await readJson(req)
        return sendJson(res, 200, {
          task: coordination.claimTask(decodeURIComponent(parts[2]), String(body.agentId ?? ''))
        })
      }
      if (method === 'DELETE' && parts[1] === 'tasks' && parts.length === 3) {
        const body = await readJson(req)
        if (!coordination.isManager(body.agentId)) throw new Forbidden('only the manager may delete tasks')
        coordination.deleteTask(decodeURIComponent(parts[2]))
        return sendJson(res, 200, { ok: true })
      }
      if (method === 'GET' && parts[1] === 'locks') {
        return sendJson(res, 200, { locks: coordination.snapshot().locks })
      }
      if (method === 'PATCH' && parts[1] === 'tasks' && parts.length === 3) {
        const body = await readJson(req)
        return sendJson(res, 200, {
          task: coordination.updateTask(decodeURIComponent(parts[2]), String(body.agentId ?? ''), body.state)
        })
      }
      if (method === 'POST' && parts[1] === 'locks') {
        const body = await readJson(req)
        return sendJson(res, 200, {
          lock: coordination.lockFile({
            path: String(body.path ?? ''),
            taskId: String(body.taskId ?? ''),
            agentId: String(body.agentId ?? ''),
            ttlMs: body.ttlMs
          })
        })
      }
      if (method === 'DELETE' && parts[1] === 'locks' && parts[2]) {
        const body = await readJson(req)
        coordination.unlockFile(decodeURIComponent(parts[2]), String(body.agentId ?? ''))
        return sendJson(res, 200, { ok: true })
      }
    }

    // ---- widgets / terminals ---------------------------------------------
    // Terminals come from the live TerminalManager (titles/aliveness for
    // every pty this session); notes come from the canvas layout on disk —
    // the last saved snapshot, since the renderer owns the live one. Together
    // they give an agent every widget's title, not just terminals.
    if (method === 'GET' && parts[0] === 'widgets' && parts.length === 1) {
      const notes = canvas
        .load()
        .widgets.filter((w) => w.kind === 'note')
        .map((w) => ({ id: w.id, title: w.title, kind: 'note' as const, noteId: w.noteId }))
      const shells = terminals.list().map((t) => ({ ...t, kind: 'terminal' as const }))
      return sendJson(res, 200, { widgets: [...shells, ...notes] })
    }

    if (method === 'POST' && parts[0] === 'widgets' && parts[1] === 'terminal') {
      const body = await readJson(req)
      // The UI can always open terminals. Once a manager exists, remote callers
      // must prove they are that manager so stray agents cannot spawn windows.
      if (coordination.managerId && !coordination.isManager(body.agentId)) {
        throw new Forbidden('only the manager may create widgets', 403, { managerId: coordination.managerId })
      }
      const info = terminals.reserve({
        title: typeof body.title === 'string' ? body.title : undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : deps.defaultCwd(),
        prefix: 'agent'
      })
      deps.requestWidget({ id: info.id, title: info.title })
      const ready = await terminals.waitUntilRunning(info.id)
      if (!ready) {
        // The renderer never mounted a widget for this id (window still
        // starting, or closed). Drop the reservation instead of leaving a
        // terminal that `list()` reports but no process or window backs.
        terminals.dispose(info.id)
        deps.requestWidgetRemoval(info.id)
        return sendJson(res, 503, {
          error: 'the Workspace window did not open a terminal for this request',
          id: info.id
        })
      }
      return sendJson(res, 200, { id: info.id, title: info.title, cwd: info.cwd, ready })
    }

    if (method === 'DELETE' && parts[0] === 'widgets' && parts[1]) {
      const id = decodeURIComponent(parts[1])
      const body = await readJson(req)
      // Same rule as widget creation: once a manager exists, remote callers must
      // prove they are that manager so stray agents cannot close each other's windows.
      if (coordination.managerId && !coordination.isManager(body.agentId)) {
        throw new Forbidden('only the manager may close widgets', 403, { managerId: coordination.managerId })
      }
      if (!terminals.has(id)) return sendJson(res, 404, { error: 'terminal not found', id })
      terminals.dispose(id)
      deps.requestWidgetRemoval(id)
      return sendJson(res, 200, { ok: true, id })
    }

    if (method === 'POST' && parts[0] === 'terminal' && parts[2] === 'write') {
      const id = decodeURIComponent(parts[1])
      const body = await readJson(req)
      if (!(await terminals.waitUntilRunning(id))) return sendJson(res, 404, { error: 'terminal not found' })
      const text = typeof body.text === 'string' ? body.text : ''
      terminals.write(id, text + (body.pressEnter === false ? '' : '\r'))
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'GET' && parts[0] === 'terminal' && parts[2] === 'output') {
      const id = decodeURIComponent(parts[1])
      const output = terminals.readOutput(id, url.searchParams.get('clear') === '1')
      if (output === null) return sendJson(res, 404, { error: 'terminal not found' })
      return sendJson(res, 200, { output })
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    if (err instanceof Forbidden) {
      return sendJson(res, err.status, { error: err.message, ...err.details })
    }
    throw err
  }
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
