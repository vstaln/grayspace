import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** The packaged executable: `ORCSPACE_PACKAGED`, or electron-builder's default unpacked output. */
export function packagedExecutable(): string {
  if (process.env.ORCSPACE_PACKAGED) return path.resolve(process.env.ORCSPACE_PACKAGED)
  return path.resolve(process.platform === 'win32' ? 'dist/win-unpacked/OrcSpace.exe' : 'dist/linux-unpacked/orcspace')
}

export async function launchPackaged() {
  const executable = packagedExecutable()
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orcspace-packaged-e2e-'))
  const debugPort = await freePort()
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.WORKSPACE_CONTROL_PORT
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ORCSPACE_TEST_USER_DATA
  delete env.ORCSPACE_DEV_USER_DATA
  // The Chromium sandbox stays on: on Linux the caller provides a display and
  // a setuid chrome-sandbox, exactly as the .deb installs it.
  const child = spawn(executable, [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, '--disable-gpu'], {
    env, windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32'
  })
  const stop = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)])
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
        }
      }
    }
    await delay(300)
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Packaged app exited: ${child.exitCode}`)
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) })
        if (response.ok) { ready = true; break }
      } catch {}
      await delay(200)
    }
    if (!ready) throw new Error('Packaged UI automation endpoint unavailable')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
    const context = browser.contexts()[0]
    const page = context.pages()[0] || await context.waitForEvent('page')
    await page.waitForLoadState('domcontentloaded')
    const controlToken = fs.readFileSync(path.join(profileDir, 'control-token'), 'utf8').trim()
    const runtime = JSON.parse(fs.readFileSync(path.join(profileDir, 'runtime.json'), 'utf8'))
    if (runtime.controlPort || !runtime.socketPath) throw new Error('Packaged app must expose IPC only')
    return { page, profileDir, controlPort: 0, socketPath: String(runtime.socketPath), controlToken, close: async () => { await browser.close(); await stop() } }
  } catch (error) {
    await stop()
    throw error
  }
}
