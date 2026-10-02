const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const requestIpc = require('./ipc-request.cjs')

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null

async function stopProcessGroup(child) {
  if (!child.pid || hasExited(child)) return
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)])
  if (!hasExited(child)) {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2_000)])
  }
  if (!hasExited(child)) throw new Error('Packaged Linux process group did not stop.')
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Linux package smoke check must run on Linux.')
  const directory = path.resolve(process.argv[2] || 'dist/installers/linux/linux-unpacked')
  const binary = path.join(directory, 'orcspace')
  if (!fs.existsSync(binary)) throw new Error(`Packaged OrcSpace executable is missing: ${binary}`)

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-packaged-linux-smoke-'))
  const env = { ...process.env }
  delete env.WORKSPACE_CONTROL_PORT
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn('xvfb-run', ['-a', binary, `--user-data-dir=${profile}`, '--disable-gpu'], {
    env,
    stdio: 'ignore',
    detached: true
  })
  let launchError
  child.on('error', (error) => { launchError = error })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw new Error(`Could not start xvfb-run: ${launchError.message}`)
      if (hasExited(child)) throw new Error(`Packaged app exited early with ${child.exitCode ?? child.signalCode}`)
      try {
        const token = fs.readFileSync(path.join(profile, 'control-token'), 'utf8').trim()
        const runtime = JSON.parse(fs.readFileSync(path.join(profile, 'runtime.json'), 'utf8'))
        if (runtime.controlPort) throw new Error('Packaged app unexpectedly advertises a TCP port')
        const response = await requestIpc(runtime.socketPath, '/health', {
          headers: { 'x-orcspace-token': token }
        })
        if (response.status === 200 && response.json.ok && response.json.app === 'orcspace') {
          console.log('Packaged Linux startup and authenticated IPC health check passed.')
          return
        }
      } catch {}
      await delay(200)
    }
    throw new Error('Packaged Linux app failed to become healthy')
  } finally {
    await stopProcessGroup(child)
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
