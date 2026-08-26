// Smoke test: boots the real server on an ephemeral port and checks
// tools/list — count, names, and that every tool has a non-empty description.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const PORT = 47991
const TOKEN = 'smoke-token'
const child = spawn(process.execPath, ['dist/index.js'], {
  env: { ...process.env, WORKSPACE_MCP_PORT: String(PORT), ORCSPACE_CONTROL_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`))

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'x-orcspace-token': TOKEN
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      })
      if (probe.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not come up')
}

async function callRpc(body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: HEADERS, body })
  const raw = await res.text()
  if (raw.startsWith('event:')) {
    const line = raw.split('\n').find((l) => l.startsWith('data:')) ?? ''
    return JSON.parse(line.slice(5).trim())
  }
  return JSON.parse(raw)
}

try {
  await waitForServer()
  const payload = await callRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  const tools = payload.result?.tools ?? []
  console.log(`TOOLS: ${tools.length}`)
  for (const t of tools) {
    const desc = typeof t.description === 'string' ? t.description : ''
    const actions = desc.match(/Actions?:\s*([^.;]+)/i)?.[1] ?? ''
    console.log(` - ${t.name} :: ${actions.trim() || '(no actions)'}`)
    if (!desc) { console.error('EMPTY DESCRIPTION'); process.exitCode = 1 }
    if (!t.inputSchema?.properties?.action && t.name !== 'read_journal' && t.name !== 'terminal_permission') {
      console.error(`${t.name} is missing the action discriminator`); process.exitCode = 1
    }
  }
  const expected = ['brain', 'terminal', 'terminal_permission', 'canvas', 'board', 'locks', 'git', 'plan', 'read_journal']
  const names = tools.map((t) => t.name).sort()
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) {
    console.error('TOOL SET MISMATCH:', names)
    process.exitCode = 1
  }
} finally {
  child.kill()
}
