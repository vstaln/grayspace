const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const requestIpc = require('./ipc-request.cjs')
const { spawn, spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

async function main() {
  const directory = path.resolve(process.argv[2] || 'dist/win-unpacked')
  const binary = path.join(directory, 'OrcSpace.exe')
  const cli = path.join(directory, 'resources', 'cli', 'orc.mjs')
  const help = spawnSync(binary, [cli, '--help'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--invalid-option-security-probe' },
    encoding: 'utf8', timeout: 15_000, windowsHide: true
  })
  if (help.status !== 0 || !help.stdout.includes('OrcSpace')) throw new Error('Packaged CLI or NODE_OPTIONS fuse failed')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-packaged-smoke-'))
  const env = { ...process.env }
  delete env.WORKSPACE_CONTROL_PORT
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(binary, [`--user-data-dir=${profile}`, '--disable-gpu'], { env, stdio: 'ignore', windowsHide: true })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Packaged app exited: ${child.exitCode}`)
      try {
        const token = fs.readFileSync(path.join(profile, 'control-token'), 'utf8').trim()
        const runtime = JSON.parse(fs.readFileSync(path.join(profile, 'runtime.json'), 'utf8'))
        if (runtime.controlPort) throw new Error('Packaged app unexpectedly advertises a TCP port')
        const response = await requestIpc(runtime.socketPath, '/health', {
          headers: { 'x-orcspace-token': token }
        })
        const health = response.json
        if (response.status === 200 && health.ok && health.app === 'orcspace') {
          console.log('Packaged startup, authenticated health, CLI and NODE_OPTIONS protection passed.')
          return
        }
      } catch {}
      await delay(200)
    }
    throw new Error('Packaged app failed to become healthy')
  } finally {
    if (child.pid && child.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
    await delay(500)
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
