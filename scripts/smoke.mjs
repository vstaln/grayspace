#!/usr/bin/env node
// Slate 0.0.1 smoke: spawns the native release binary, waits for its
// control server, and GETs /health over the IPC socket.
//
// Needs a display (xvfb-run on headless Linux): the binary opens its window
// after starting the control server, so without a display the process exits
// and this fails with the exit message below instead of hanging.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import requestIpc from './ipc-request.cjs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binary = path.join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'slate.exe' : 'slate')
const timeoutMs = Number(process.env.SLATE_SMOKE_TIMEOUT_MS || 60_000)

if (!fs.existsSync(binary)) {
  console.error(`[smoke] binary not found: ${binary}`)
  console.error('[smoke] run `npm run native:build` first.')
  process.exit(1)
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-smoke-'))
const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\slate-smoke-${process.pid}`
  : path.join(profileDir, 'slate.sock')
// Fixed token so the check knows what to present. The binary persists the
// same value to control-token, which is what `slate` reads in real use.
const token = 'smoke-test-token-0123456789abcdef0123456789abcdef'

let child
let exited = false
let childError = null
let hardStopTimer = null

child = spawn(binary, [], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    SLATE_TEST_USER_DATA: profileDir,
    SLATE_SOCKET_PATH: socketPath,
    SLATE_TOKEN: token
  }
})

child.once('exit', () => { exited = true })
child.once('error', (error) => {
  childError = error
  exited = true
})

function childExitMessage(phase) {
  if (childError) return `Slate failed during ${phase}: ${childError.message}`
  return `Slate exited before ${phase} (needs a display — use xvfb-run on headless Linux)`
}

async function waitForToken(deadline) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(childExitMessage('control server startup'))
    try {
      const stored = fs.readFileSync(path.join(profileDir, 'control-token'), 'utf8').trim()
      if (stored === token) return stored
      if (stored.length >= 32) throw new Error('control token mismatch: binary did not use SLATE_TOKEN')
    } catch (error) {
      if (error.message.startsWith('control token mismatch')) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`control server did not start: control token did not appear within ${timeoutMs}ms`)
}

async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(childExitMessage('control server health'))
    try {
      const response = await requestIpc(socketPath, '/health', { headers: { 'x-slate-token': token } })
      if (response.status === 200 && response.json && response.json.ok === true) return
    } catch {
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`control server did not become healthy within ${timeoutMs}ms`)
}

function stop() {
  if (!child || exited) return
  if (process.platform === 'win32' && child.pid) {
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
  console.error(`[smoke] hard timeout after ${timeoutMs + 5_000}ms; force-killing Slate process tree`)
  stop()
  process.exit(124)
}

try {
  hardStopTimer = setTimeout(emergencyStop, timeoutMs + 5_000)
  const deadline = Date.now() + timeoutMs
  await waitForToken(deadline)
  await waitForHealth(deadline)
  console.log('[smoke] IPC control server health passed over the native socket')
} catch (error) {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (hardStopTimer) clearTimeout(hardStopTimer)
  stop()
  const removalDeadline = Date.now() + 5_000
  let removed = false
  while (Date.now() < removalDeadline) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
      removed = true
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  if (!removed) {
    console.warn(`[smoke] could not remove temporary profile after 5s: ${profileDir}`)
  }
}
