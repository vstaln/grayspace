#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// import.meta.dirname needs Node >= 20.11; resolve from the module URL so the
// script fails late (with diagnostics) rather than at line one everywhere.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'dist', 'win-unpacked', 'OrcSpace.exe')
const requestedControlPort = process.env.WORKSPACE_CONTROL_PORT
const timeoutMs = Number(process.env.ORCSPACE_SMOKE_TIMEOUT_MS || 60_000)
let userDataDir
let child
let exited = false
let childError = null
let hardStopTimer = null

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Accepts only a real decimal port; "" / "0" / "8x" fall back to a free one. */
function parsePort(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

const controlPort = parsePort(requestedControlPort) ?? await freePort()
const controlUrl = `http://127.0.0.1:${controlPort}/health`

if (!fs.existsSync(executable)) {
  console.error(`[smoke] executable not found: ${executable}`)
  process.exit(1)
}

userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orcspace-smoke-'))

child = spawn(executable, [`--user-data-dir=${userDataDir}`, '--disable-gpu'], {
  cwd: path.dirname(executable),
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    WORKSPACE_CONTROL_PORT: String(controlPort),
  }
})

child.once('exit', () => { exited = true })
child.once('error', (error) => {
  childError = error
  exited = true
})

function childExitMessage(phase) {
  if (childError) return `OrcSpace failed during ${phase}: ${childError.message}`
  return `OrcSpace exited before ${phase}`
}

async function request(url, init, timeout = 2_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function waitForToken(deadline) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(childExitMessage('control server startup'))
    try {
      const token = fs.readFileSync(path.join(userDataDir, 'control-token'), 'utf8').trim()
      if (token.length >= 32) return token
    } catch {
      // The app creates the profile and token during startup.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`control server did not start: control token did not appear within ${timeoutMs}ms`)
}

async function waitForControl(token, deadline) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(childExitMessage('control server health'))
    try {
      const response = await request(controlUrl, { headers: { 'x-orcspace-token': token } })
      if (response.ok) {
        const body = await response.json()
        if (body?.ok === true) return
      }
    } catch {
      // Retry until the app finishes startup.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`control server did not become healthy within ${timeoutMs}ms`)
}

function stop() {
  if (!child || exited) return
  if (process.platform === 'win32' && child.pid) {
    // /t is important: the app owns the whole process tree.
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true
    })
  } else if (child.pid) {
    child.kill('SIGTERM')
    setTimeout(() => { if (!exited) child.kill('SIGKILL') }, 2_000).unref()
  }
  exited = true
}

function emergencyStop() {
  console.error(`[smoke] hard timeout after ${timeoutMs + 5_000}ms; force-killing OrcSpace process tree`)
  stop()
  process.exit(124)
}

try {
  // This timer covers a hung fetch, a stuck child shutdown, or any future
  // await added to the checks. The smoke command must never hold CI forever.
  hardStopTimer = setTimeout(emergencyStop, timeoutMs + 5_000)
  const deadline = Date.now() + timeoutMs
  const token = await waitForToken(deadline)
  await waitForControl(token, deadline)
  console.log('[smoke] combined renderer/control server health passed')
} catch (error) {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (hardStopTimer) clearTimeout(hardStopTimer)
  stop()
  // On Windows taskkill /f returns before the dying tree has released its file
  // handles, so a single rmSync usually races the app process and
  // leaks the profile. Retry briefly until the handles are gone.
  const removalDeadline = Date.now() + 5_000
  let removed = false
  while (Date.now() < removalDeadline) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
      removed = true
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  if (!removed) {
    console.warn(`[smoke] could not remove temporary profile after 5s: ${userDataDir}`)
  }
}
