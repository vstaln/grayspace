const CONTROL_PORT = Number(process.env.WORKSPACE_CONTROL_PORT || 47932)
export const MCP_PORT = Number(process.env.WORKSPACE_MCP_PORT || 47940)
const CONTROL_BASE = `http://localhost:${CONTROL_PORT}`

/** Calls the Workspace app's loopback control API and surfaces its errors. */
export async function controlApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONTROL_BASE}${path}`, init)
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
