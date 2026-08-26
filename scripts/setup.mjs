#!/usr/bin/env node
// Cross-platform setup — mirrors setup.bat but for `node scripts/setup.mjs`.
// One OrcSpace backend on :20220, no Dashboard. MCP is embedded in the app.

import { spawnSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mcpRoot = join(root, 'Orcspace-mcp')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd: opts.cwd ?? root })
  return r.status === 0
}

async function alive(url, ms = 900) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), ms)
    const r = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    return r.ok
  } catch { return false }
}

console.log('\n OrcSpace Setup — backend :20220 (Control + MCP)\n' + '─'.repeat(58))

if (!existsSync(join(root, 'node_modules'))) {
  console.log(' Installing app dependencies...')
  if (!sh('npm', ['install', '--no-fund', '--no-audit'])) process.exit(1)
} else console.log(' [ok] App dependencies present.')

if (existsSync(join(mcpRoot, 'package.json'))) {
  if (!existsSync(join(mcpRoot, 'node_modules'))) {
    console.log(' Installing MCP dependencies...')
    sh('npm', ['install', '--no-fund', '--no-audit'], { cwd: mcpRoot })
  } else console.log(' [ok] MCP dependencies present.')
  console.log(' Building MCP...')
  sh('npm', ['run', 'build'], { cwd: mcpRoot })
} else console.log(' [!] Orcspace-mcp folder not found - skipping MCP.')

console.log(' Building native crates (best-effort)...')
sh('npm', ['run', 'build:native'])

if (await alive('http://127.0.0.1:20220/presence')) {
  console.log('\n [ok] The app is already live on :20220 - no second instance needed.\n')
} else {
  console.log('\n Starting the app (npm run dev)... leave this window open.\n')
  const child = spawn('npm', ['run', 'dev'], { cwd: root, shell: true, stdio: 'inherit', detached: false })
  // wait for presence
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 2000))
    if (await alive('http://127.0.0.1:20220/presence')) break
    if (i === 39) console.log(' [!] The app is still starting (>80s) - see the log above.')
  }
}

try {
  const r = await fetch('http://127.0.0.1:20220/mcp', { signal: AbortSignal.timeout(1500) })
  console.log(r.ok || r.status === 406 || r.status === 404 ? ` [ok] MCP is responding (${r.status})` : ` [!] MCP status ${r.status}`)
} catch { console.log(' [..] MCP is still coming up - the app retries with backoff.') }

try {
  const r = await fetch('http://127.0.0.1:20220/presence', { signal: AbortSignal.timeout(1200) })
  const j = await r.json()
  console.log(` App presence: pid ${j.pid}  mcpRunning=${j.mcpRunning}  dir=${j.workspaceDir || '(no folder)'}`)
} catch { console.log(' [!] /presence did not answer.') }

console.log('\n Done. App + MCP start automatically; the Dashboard is disabled.\n')
