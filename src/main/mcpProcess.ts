import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import * as fs from 'fs'
import { CONTROL_PORT, MCP_PORT } from './config'
import { killProcessTree } from './procTree'

export interface McpStatus {
  /** True while the bundled server process is alive. */
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

function scriptPath(): string {
  return join(__dirname, '../../mcp-server/dist/index.js')
}

export function mcpStatus(): McpStatus {
  return {
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
  spawnServer()
}

function spawnServer(): void {
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
        WORKSPACE_MCP_PORT: String(MCP_PORT)
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
    if (message) lastError = message
    console.error('[mcp]', message)
  })
  child.on('error', (err) => {
    lastError = String(err.message || err)
    console.error('[mcp] process error', err)
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
}

function scheduleRestart(): void {
  if (stopped || restartTimer || restarts >= MAX_RESTARTS) {
    if (restarts >= MAX_RESTARTS) {
      lastError = `${lastError ?? 'MCP server keeps exiting'} — giving up after ${restarts} restarts.`
    }
    return
  }
  const delay = RETRY_DELAYS[Math.min(restarts, RETRY_DELAYS.length - 1)]
  restarts += 1
  restartTimer = setTimeout(() => {
    restartTimer = null
    spawnServer()
  }, delay)
  // A pending restart must not hold the app open at quit time.
  restartTimer.unref?.()
}

/** Manual restart from the UI: clears the backoff and starts again immediately. */
export function restartMcpServer(): McpStatus {
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
    previous.removeAllListeners('exit')
    try {
      previous.kill()
    } catch {
      /* already gone */
    }
    // UNVERIFIED #2: on Windows a plain kill() can leave the server's
    // descendants (conpty helpers, spawned agents) running; sweep them like
    // terminals do — best-effort and after a short settle delay.
    killProcessTree(previous.pid)
  }
  spawnServer()
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
    child.kill()
    killProcessTree(pid)
  }
  child = null
  publish()
}
