const CONTROL_PORT = Number(process.env.WORKSPACE_CONTROL_PORT || 47932)
export const MCP_PORT = Number(process.env.WORKSPACE_MCP_PORT || 47940)
const CONTROL_BASE = `http://localhost:${CONTROL_PORT}`

/**
 * Shared secret with the app, handed to this process in its environment when
 * the app spawns it. Loopback alone is not authorisation — every process on
 * the machine can reach 127.0.0.1, and this API opens shells — so the app
 * refuses any request without it.
 */
const CONTROL_TOKEN = process.env.ORCSPACE_CONTROL_TOKEN || ''
const TOKEN_HEADER = 'x-orcspace-token'

/** Calls the OrcSpace app's loopback control API and surfaces its errors. */
export async function controlApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONTROL_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), [TOKEN_HEADER]: CONTROL_TOKEN }
  })
  const data = (await res.json()) as T
  if (!res.ok) {
    throw new Error(`workspace app returned ${res.status}: ${JSON.stringify(data)}`)
  }
  return data
}

export function post(path: string, body: unknown): Promise<unknown> {
  return controlApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text: rendered || '(пусто)' }] }
}
