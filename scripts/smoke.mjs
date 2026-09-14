#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import requestIpc from './ipc-request.cjs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'



const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'dist', 'win-unpacked', 'OrcSpace.exe')
const timeoutMs = Number(process.env.ORCSPACE_SMOKE_TIMEOUT_MS || 60_000)
let userDataDir
let child
let exited = false
let childError = null
let hardStopTimer = null





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
    WORKSPACE_CONTROL_PORT: '',
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


async function waitForToken(deadline) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(childExitMessage('control server startup'))
    try {
      const token = fs.readFileSync(path.join(userDataDir, 'control-token'), 'utf8').trim()
      if (token.length >= 32) return token
    } catch {

    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`control server did not start: control token did not appear within ${timeoutMs}ms`)
}

async function waitForControl(token, deadline) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(childExitMessage('control server health'))
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(userDataDir, 'runtime.json'), 'utf8'))
      if (runtime.controlPort) throw new Error('Packaged app unexpectedly advertises a TCP port')
      const response = await requestIpc(runtime.socketPath, '/health', { headers: { 'x-orcspace-token': token } })
      if (response.status === 200) {
        const body = response.json
        if (body?.ok === true) return
      }
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
  console.error(`[smoke] hard timeout after ${timeoutMs + 5_000}ms; force-killing OrcSpace process tree`)
  stop()
  process.exit(124)
}

try {


  hardStopTimer = setTimeout(emergencyStop, timeoutMs + 5_000)
  const deadline = Date.now() + timeoutMs
  const token = await waitForToken(deadline)
  await waitForControl(token, deadline)
  console.log('[smoke] IPC control server health passed; no TCP port advertised')
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
