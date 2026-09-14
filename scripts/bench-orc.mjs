import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const baseline = execFileSync('git', ['show', `${process.argv[2] || 'HEAD'}:cli/orc.mjs`], { encoding: 'utf8' })
const current = readFileSync(new URL('../cli/orc.mjs', import.meta.url), 'utf8')
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end('{}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, ORCSPACE_URL: `http://127.0.0.1:${server.address().port}`, ORCSPACE_TOKEN: 't'.repeat(64) }
delete env.ORCSPACE_SOCKET_PATH
try {
  const samples = { before: [], after: [] }
  for (let i = 0; i < 16; i++) {
    for (const [name, source] of [['before', baseline], ['after', current]]) {
      const start = performance.now()
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-', 'api', 'GET', '/test', '--json'], { env, stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)))
        child.stdin.end(source)
      })
      if (i > 0) samples[name].push(performance.now() - start)
    }
  }
  for (const [name, times] of Object.entries(samples)) {
    times.sort((a, b) => a - b)
    console.log(`${name}: median ${times[Math.floor(times.length / 2)].toFixed(1)} ms (${times.length} launches)`)
  }
} finally {
  server.closeAllConnections()
  server.close()
}
