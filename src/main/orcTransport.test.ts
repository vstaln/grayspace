import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as http from 'node:http'
import * as https from 'node:https'

const exec = promisify(execFile)
const cli = resolve('cli/orc.mjs')
const source = readFileSync(cli, 'utf8')

type Result = { status: number | string; data: Record<string, any> }
async function withServer(handler: RequestListener, check: (run: (args: string[]) => Promise<Result>) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  const run = async (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ORCSPACE_URL: `http://127.0.0.1:${address.port}`, ORCSPACE_TOKEN: 't'.repeat(64) }
    delete env.ORCSPACE_SOCKET_PATH
    try {
      const result = await exec(process.execPath, [cli, ...args, '--json'], { env, timeout: 5000 })
      return { status: 0, data: JSON.parse(result.stdout) }
    } catch (error) {
      const failure = error as Error & { killed: boolean; code: number | string; stdout: string }
      assert.equal(failure.killed, false, 'CLI must exit without hanging')
      return { status: failure.code, data: JSON.parse(failure.stdout) }
    }
  }
  try { await check(run) } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

test('CLI rejects malformed JSON instead of reporting success', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{broken')
  }, async (run) => {
    const result = await run(['api', 'GET', '/test'])
    assert.equal(result.status, 1)
    assert.equal(result.data.code, 'invalid_response')
  })
})

test('CLI fails promptly on a truncated HTTP response', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000 })
    res.write('{"ok":')
    setImmediate(() => res.destroy())
  }, async (run) => {
    const result = await run(['api', 'GET', '/test'])
    assert.equal(result.status, 1)
    assert.equal(result.data.code, 'response_interrupted')
  })
})

test('CLI sends UTF-8 JSON with a correct content length', async () => {
  await withServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ body: JSON.parse(body.toString()), length: body.length, declared: Number(req.headers['content-length']) }))
    })
  }, async (run) => {
    const result = await run(['plan', 'create', 'Проверка 🚀'])
    assert.equal(result.status, 0)
    assert.equal(result.data.body.title, 'Проверка 🚀')
    assert.equal(result.data.length, result.data.declared)
  })
})

test('CLI supports -- before positional values starting with dashes', async () => {
  await withServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(Buffer.concat(chunks))
    })
  }, async (run) => {
    const result = await run(['--json=true', 'plan', 'create', '--', '--literal-title'])
    assert.equal(result.status, 0)
    assert.equal(result.data.title, '--literal-title')
  })
})

test('transport deadline covers a stalled response body', async () => {
  const requestTarget = runInNewContext(
    source.slice(source.indexOf('class OrcError'), source.indexOf('async function call(')) + '\nrequestTarget',
    { http, https, URL, Buffer, setTimeout, clearTimeout }
  )
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    await assert.rejects(requestTarget({
      target: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` },
      method: 'GET', path: '/', headers: {}, timeoutMs: 100
    }), { code: 'timeout' })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

test('mutating requests are never replayed after timeout or connection loss', async () => {
  for (const code of ['timeout', 'connection_lost', 'response_interrupted', 'http_404']) {
    let attempts = 0
    const call = runInNewContext(
      source.slice(source.indexOf('class OrcError'), source.indexOf('async function requestTarget(')) +
      '\nlet workingToken = null, workingTarget = null;\n' +
      source.slice(source.indexOf('async function call('), source.indexOf('const get =')) + '\ncall',
      {
        getCandidateTokens: () => ['token'], targets: () => [{ url: 'first' }, { url: 'second' }],
        TOKEN_HEADER: 'x-orcspace-token',
        requestTarget: async () => { attempts++; return { ok: false, status: 500, payload: { error: 'failure', code } } }
      }
    )
    await assert.rejects(call('POST', '/test', {}), { code })
    assert.equal(attempts, 1)
  }
})
