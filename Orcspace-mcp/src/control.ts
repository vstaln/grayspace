function configuredPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback
}

const CONTROL_PORT = configuredPort(process.env.WORKSPACE_CONTROL_PORT, 47932)
export const MCP_PORT = configuredPort(process.env.WORKSPACE_MCP_PORT, 47940)
// The control server binds IPv4 loopback explicitly.  Do not use `localhost`
// here: on hosts that resolve it to ::1 first, MCP calls fail even though the
// app is healthy and listening on 127.0.0.1.
const CONTROL_BASE = `http://127.0.0.1:${CONTROL_PORT}`
const CONTROL_TIMEOUT_MS = 15_000

/**
 * Shared secret with the app, handed to this process in its environment when
 * the app spawns it. Loopback alone is not authorisation — every process on
 * the machine can reach 127.0.0.1, and this API opens shells — so the app
 * refuses any request without it.
 *
 * The same token gates the MCP endpoint itself (`/mcp`): an attacker who can
 * reach loopback must also know the token before `create_terminal` opens a
 * shell. When no token was configured (a manually-started server) the gate
 * fails closed — every request is refused.
 */
import { createHash, timingSafeEqual } from 'crypto'

export const CONTROL_TOKEN = process.env.ORCSPACE_CONTROL_TOKEN || ''
export const TOKEN_HEADER = 'x-orcspace-token'

/** Timing-safe comparison so length differences cannot leak the token. */
export function tokenMatches(presented: string | undefined): boolean {
  if (!CONTROL_TOKEN || typeof presented !== 'string') return false
  const ha = createHash('sha256').update(presented, 'utf8').digest()
  const hb = createHash('sha256').update(CONTROL_TOKEN, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/** Calls the OrcSpace app's loopback control API and surfaces its errors. */
export async function controlApi<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${CONTROL_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...(init?.headers as Record<string, string> | undefined), [TOKEN_HEADER]: CONTROL_TOKEN }
    })
  } catch (error) {
    const isConnRefused =
      error instanceof TypeError &&
      (String(error).includes('fetch failed') ||
        (error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED')
    const detail = isConnRefused
      ? `OrcSpace desktop app is not running or unreachable on 127.0.0.1:${CONTROL_PORT}`
      : error instanceof Error && error.name === 'AbortError'
        ? `timed out after ${CONTROL_TIMEOUT_MS}ms`
        : String(error)
    throw new Error(`workspace control API request to ${path} failed: ${detail}`)
  } finally {
    clearTimeout(timer)
  }

  const raw = await res.text()
  let data: T | { error?: unknown }
  try {
    data = raw ? (JSON.parse(raw) as T) : ({} as T)
  } catch {
    throw new Error(`workspace app returned invalid JSON for ${path} (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const errorMsg = (data as { error?: unknown; message?: unknown })?.error || (data as { message?: unknown })?.message || JSON.stringify(data)
    throw new Error(`workspace app returned ${res.status}: ${String(errorMsg)}`)
  }
  return data as T
}

export function post(path: string, body: unknown): Promise<unknown> {
  return controlApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** PATCH/DELETE with a JSON body — the write verbs `post` does not cover. */
export function send(path: string, method: 'PATCH' | 'DELETE', body: unknown): Promise<unknown> {
  return controlApi(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text: rendered || '(empty)' }] }
}
