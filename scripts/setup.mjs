#!/usr/bin/env node
// Cross-platform setup — Node.js runner for `npm run setup` / `node scripts/setup.mjs`.
// Manages dependencies, native accelerators, and app launch.

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = process.env.WORKSPACE_CONTROL_PORT || '20220'
const MIN_NODE_MAJOR = 20
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const args = process.argv.slice(2)
const flags = {
  reinstall: args.includes('--reinstall') || args.includes('-r'),
  build: args.includes('--build') || args.includes('-b'),
  reset: args.includes('--reset'),
  noStart: args.includes('--no-start'),
  check: args.includes('--check') || args.includes('-c'),
  help: args.includes('--help') || args.includes('-h')
}

if (flags.help) {
  console.log(`
 OrcSpace Setup & Launch Utility (Node CLI)
 ──────────────────────────────────────────────────────────
 Usage:
   node scripts/setup.mjs [options]
   npm run setup [-- options]

 Options:
   --reinstall, -r  Clean reinstall all node_modules and start
   --build, -b      Build production desktop distribution (dist)
   --reset          Reset locks, actor presence, and canvas
   --check, -c      Preflight check and verify running services
   --no-start       Install and compile without launching app
   --help, -h       Show this help message
`)
  process.exit(0)
}


function sh(cmd, shArgs, opts = {}) {
  const r = spawnSync(cmd, shArgs, { stdio: 'inherit', shell: process.platform === 'win32', cwd: opts.cwd ?? root })
  return r.status === 0
}

async function alive(url, ms = 1000) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), ms)
    const r = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

console.log('\n OrcSpace Setup — Unified Canvas & Agent Coordination')
console.log(` Backend :${APP_PORT} (Control + renderer)\n` + '─'.repeat(58))

// 1. Preflight check
const nodeVersion = process.version
const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10)

if (nodeMajor < MIN_NODE_MAJOR) {
  console.error(`\n [x] Node.js >= ${MIN_NODE_MAJOR} required. Currently installed: ${nodeVersion}`)
  console.error('     Please update Node.js from https://nodejs.org/\n')
  process.exit(1)
}
console.log(` [ok] Node.js ${nodeVersion} (${process.platform}-${process.arch})`)

// npm is the only supported package manager for the checked-in lockfile.
// Failing early here avoids a half-installed app when a machine has no npm
// shim (common with portable Node installations on Windows).
const npmCheck = spawnSync(npmCommand, ['--version'], {
  stdio: 'ignore',
  shell: process.platform === 'win32'
})
if (npmCheck.status !== 0) {
  console.error(' [x] npm is not available on PATH. Install the Node.js LTS bundle and retry.')
  process.exit(1)
}

// Check cargo (optional)
const cargoCheck = spawnSync('cargo', ['--version'], { shell: process.platform === 'win32' })
if (cargoCheck.status === 0) {
  console.log(` [ok] Rust accelerator available`)
} else {
  console.log(` [i] Rust not installed — using TypeScript fallback accelerators`)
}

// 2. Handle reset mode
if (flags.reset) {
  console.log('\n ==> Resetting locks and workspace state...')
  sh('node', ['scripts/reset.mjs', '--all'])
  console.log(' [ok] Reset completed.\n')
  process.exit(0)
}

// 3. Clean reinstall if requested
if (flags.reinstall) {
  console.log('\n ==> Cleaning existing dependencies...')
  try {
    if (existsSync(join(root, 'node_modules'))) rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    console.log(' [ok] Cleaned node_modules folders.')
  } catch (err) {
    console.warn(' [!] Warning during clean:', err.message)
  }
}

// 4. App Dependencies — also detect broken install (folder exists but no .bin/electron)
if (!existsSync(join(root, 'node_modules')) || !existsSync(join(root, 'node_modules', '.bin')) || !existsSync(join(root, 'node_modules', 'electron'))) {
  const msg = existsSync(join(root, 'node_modules')) ? 'broken install detected — reinstalling...' : 'Installing app dependencies...'
  console.log(`\n ==> ${msg}`)
  if (!sh(npmCommand, ['ci', '--no-fund', '--no-audit'])) {
    console.error(' [x] npm install failed.')
    process.exit(1)
  }
  console.log(' [ok] App dependencies installed.')
} else {
  console.log(' [ok] App dependencies present.')
}

// 5. Native Accelerators
console.log(' ==> Building native accelerators...')
if (!sh(npmCommand, ['run', 'build:native'])) {
  console.error(' [x] Native accelerator build failed.')
  console.error('     Run with --no-start to inspect the compiler output, then retry setup.')
  process.exit(1)
}

// 6. Production Build mode
if (flags.build) {
  const distScript = process.platform === 'darwin' ? 'dist:mac' : 'dist'
  if (!sh(npmCommand, ['run', distScript])) {
    console.error(' [x] Distribution build failed.')
    process.exit(1)
  }
  console.log('\n [ok] Desktop build completed successfully in dist/ folder!\n')
  process.exit(0)
}

if (flags.noStart) {
  console.log('\n [ok] Setup finished successfully (--no-start).\n')
  process.exit(0)
}

// 7. Check if already running or launch
const isRunning = await alive(`http://127.0.0.1:${APP_PORT}/presence`)

if (isRunning) {
  console.log(`\n [ok] OrcSpace is already live on :${APP_PORT} — no second instance needed.`)
} else if (!flags.check) {
  console.log(`\n ==> Starting OrcSpace (npm run dev)... leave this window open.\n`)
  const child = spawn(npmCommand, ['run', 'dev'], {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    detached: false,
    windowsHide: false
  })
  child.on('error', (error) => console.error(` [x] Failed to start OrcSpace: ${error.message}`))

  console.log(` Waiting for http://127.0.0.1:${APP_PORT}/presence ...`)
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await alive(`http://127.0.0.1:${APP_PORT}/presence`)) break
    if (i === 44) console.log(' [!] App is still initializing (>90s) — check terminal output above.')
  }
}

// 8. Verify Service Health
console.log('\n ==> Service Health Check:')
try {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/presence`, { signal: AbortSignal.timeout(2000) })
  const j = await r.json()
  console.log(`  [ok] Backend presence: PID ${j.pid} | Workspace: ${j.workspaceDir || '(no folder)'}`)
} catch {
  console.log('  [!] /presence endpoint not answering yet.')
}

console.log('\n' + '═'.repeat(58))
console.log(' OrcSpace is ready!')
console.log(' Native orc CLI/orchestration is ready.')
console.log('═'.repeat(58) + '\n')
