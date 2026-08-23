import { spawn, ChildProcess } from 'child_process'
import * as electron from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import * as net from 'net'

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
import { CONTROL_PORT, MCP_PORT } from './config.ts'
import { controlToken } from './controlToken.ts'
import { killProcessTree } from './procTree.ts'

export interface McpStatus {
  /** Resolved MCP server entrypoint used by the supervisor. */
  entrypoint: string
  running: boolean
  /** Absent when the build is missing, otherwise the last failure seen. */
  error?: string
  /** How many times the supervisor has restarted the process this session. */
  restarts: number
  pid?: number
}

let child: ChildProcess | null = null
let restartTimer: NodeJS.Timeout | null = null
let restarts = 0
let lastError: string | undefined
let stopped = false
let onStatusChange: ((status: McpStatus) => void) | null = null

/** Backoff between respawns, so a server that cannot start does not spin. */
const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000]
const MAX_RESTARTS = RETRY_DELAYS.length
/** Jitter factor: ±25% of the delay to avoid thundering herd on synchronized restarts. */
const RESTART_JITTER = 0.25

/**
 * Resolve the MCP server entrypoint.
 *
 * Dev / electron-vite preview: monorepo sibling `Orcspace-mcp/dist`.
 * Packaged (NSIS / portable / win-unpacked): electron-builder
 * `extraResources` copy of `.staging/mcp`, which keeps the upstream repo
 * layout — `resources/mcp/dist/index.js`. Pointing one level higher used to
 * look for `mcp/index.js`, which never exists, so the packaged app logged
 * "MCP server build not found" and the background server never came up.
 */
function scriptPath(): string {
  if (electronApp?.isPackaged) {
    return join(process.resourcesPath, 'mcp', 'dist', 'index.js')
  }
  return join(__dirname, '../../../Orcspace-mcp/dist/index.js')
}

export function mcpStatus(): McpStatus {
  return {
    entrypoint: scriptPath(),
    running: child !== null && !child.killed,
    error: lastError,
    restarts,
    pid: child?.pid
  }
}

export function isMcpRunning(): boolean {
  return child !== null && !child.killed
}

function publish(): void {
  onStatusChange?.(mcpStatus())
}

/**
 * Runs the bundled MCP server alongside the app so any MCP client can attach to
 * http://localhost:MCP_PORT/mcp for as long as the workspace is open. It runs in
 * a plain Node context via ELECTRON_RUN_AS_NODE rather than a second Electron UI.
 *
 * The process is supervised: a crash (a port taken by a stale instance, say)
 * used to kill MCP silently for the rest of the session, so it is now respawned
 * with a backoff and its state is reported to the UI.
 */
export function startMcpServer(notify?: (status: McpStatus) => void): void {
  if (notify) onStatusChange = notify
  stopped = false
  void spawnServer()
}

function spawnServer(): Promise<void> {
  return (async () => {
    if (stopped || child) return
    // A stale listener on the MCP port (a previous run still winding down)
    // would make this spawn fail with EADDRINUSE on the very first attempt;
    // wait for the port to clear before starting (P3).
    await waitForPortFree(MCP_PORT)
    if (stopped || child) return
    const script = scriptPath()
    if (!fs.existsSync(script)) {
      lastError = `MCP server build not found at ${script} — run "npm run build:mcp".`
      console.warn(lastError)
      publish()
      return
    }

    try {
      child = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          WORKSPACE_CONTROL_PORT: String(CONTROL_PORT),
          WORKSPACE_MCP_PORT: String(MCP_PORT),
          // The bundled server is trusted local tooling, so it gets the control
          // token directly rather than being configured with it by hand.
          ORCSPACE_CONTROL_TOKEN: controlToken()
        },
        stdio: 'pipe',
        windowsHide: true
      })
    } catch (err) {
      lastError = `failed to start the MCP server: ${String(err)}`
      console.error(lastError)
      publish()
      return
    }

    lastError = undefined
    child.stdout?.on('data', (chunk) => console.log('[mcp]', String(chunk).trim()))
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message) {
        lastError = message
        publish()
      }
      console.error('[mcp]', message)
    })
    child.on('error', (err) => {
      // A failed spawn (missing script, EADDRINUSE, ...) emits 'error' and then
      // 'close' — but never 'exit' — so the exit handler that nulls `child` and
      // schedules the restart would never run. Without this the supervisor kept
      // reporting a dead process as running for the rest of the session.
      lastError = String(err.message || err)
      console.error('[mcp] process error', err)
      child = null
      if (!stopped) scheduleRestart()
      publish()
    })
    child.on('exit', (code, signal) => {
      child = null
      if (stopped) return publish()
      if (code !== 0) lastError = lastError || `MCP server exited with code ${code ?? signal}`
      console.log('MCP server exited with code', code)
      scheduleRestart()
      publish()
    })
    publish()
  })()
}

function scheduleRestart(): void {
  if (stopped || restartTimer || restarts >= MAX_RESTARTS) {
    if (restarts >= MAX_RESTARTS) {
      lastError = `${lastError ?? 'MCP server keeps exiting'} — giving up after ${restarts} restarts.`
    }
    return
  }
  const baseDelay = RETRY_DELAYS[Math.min(restarts, RETRY_DELAYS.length - 1)]
  const jitter = baseDelay * RESTART_JITTER * (Math.random() * 2 - 1)
  const delay = Math.max(100, baseDelay + jitter)
  restarts += 1
  restartTimer = setTimeout(() => {
    restartTimer = null
    void spawnServer()
  }, delay)
  // A pending restart must not hold the app open at quit time.
  restartTimer.unref?.()
}

/**
 * Waits until nothing accepts TCP connections on the MCP port, or the deadline
 * passes. After killing the old server process the OS may still hold the port
 * briefly, and spawning immediately then produces a self-inflicted EADDRINUSE
 * that makes the *first* manual restart always fail (P3).
 */
function waitForPortFree(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const probe = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const done = (free: boolean): void => {
        socket.destroy()
        resolve(free)
      }
      socket.once('connect', () => done(false))
      socket.once('error', () => done(true))
      socket.setTimeout(500, () => done(false))
    })
  return (async () => {
    while (Date.now() < deadline) {
      if (await probe()) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })()
}

let restartGate: Promise<McpStatus> | null = null

/** Manual restart from the UI: clears the backoff and starts again immediately. */
export async function restartMcpServer(): Promise<McpStatus> {
  if (restartGate) return restartGate
  restartGate = restartMcpServerNow().finally(() => {
    restartGate = null
  })
  return restartGate
}

async function restartMcpServerNow(): Promise<McpStatus> {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  restarts = 0
  lastError = undefined
  stopped = false
  if (child && !child.killed) {
    // The exit handler respawns; suppress it and do the restart ourselves so a
    // manual restart never races with the automatic one.
    const previous = child
    child = null
    // Detach EVERYTHING, not just 'exit': a late 'error' (EPERM while killing,
    // stdio teardown) from the dying process would null out the freshly
    // spawned replacement and schedule a duplicate restart — a crash-loop
    // against the port the healthy server already holds. Stale stdout/stderr
    // handlers would likewise keep reporting the dead process's last words.
    previous.removeAllListeners()
    previous.stdout?.removeAllListeners()
    previous.stderr?.removeAllListeners()
    try {
      previous.kill()
    } catch {
      /* already gone */
    }
    // On Windows a plain kill() can leave the server's descendants (conpty
    // helpers, spawned agents) running; sweep them like terminals do —
    // best-effort and after a short settle delay.
    killProcessTree(previous.pid)
    // Give the dying server's socket a moment to be released so the respawn
    // does not immediately collide on the port (P3).
    await waitForPortFree(MCP_PORT)
  }
  await spawnServer()
  return mcpStatus()
}

export function stopMcpServer(): void {
  stopped = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (child && !child.killed) {
    const pid = child.pid
    // Same as restart: fully detach so nothing the dying process emits can
    // touch module state after shutdown began.
    child.removeAllListeners()
    child.stdout?.removeAllListeners()
    child.stderr?.removeAllListeners()
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    killProcessTree(pid)
  }
  child = null
  publish()
}
