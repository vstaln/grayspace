import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { createRustPtySidecar, RustPtySidecar } from './rustPtySidecar.ts'
import { defaultShell } from './config.ts'

function simulatedSidecar() {
  const packets: Array<{ requestId: string; id: string; data: string }> = []
  const sidecar = Object.assign(Object.create(RustPtySidecar.prototype), {
    child: { exitCode: null, stdin: { destroyed: false, writableLength: 0,
      write: (line: string) => { packets.push(JSON.parse(line)); return true } } },
    stdoutBuffer: '', writeRequestCounter: 0, sessionCounter: 0,
    sessions: new Map(), sessionOwners: new Map(),
    pendingSpawns: new Set(),
    pendingSpawnTimers: new Map(),
    pendingWrites: new Map(), unacknowledged: new Map()
  }) as RustPtySidecar
  // Access the wire parser without launching a process for timeout tests.
  const receive = (event: object) => Reflect.get(sidecar, 'consumeStdout').call(sidecar, `${JSON.stringify(event)}\n`)
  return { sidecar: sidecar as RustPtySidecar, packets, receive,
    consume: (chunk: string) => Reflect.get(sidecar, 'consumeStdout').call(sidecar, chunk) }
}

test('Ctrl+C bypasses ACK cooldown and ordinary input can recover after it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { sidecar, packets, receive } = simulatedSidecar()
  const first = sidecar.write('test', 'x')
  t.mock.timers.tick(4_001)
  assert.equal((await first).ok, false)
  assert.equal((await sidecar.write('test', 'y')).ok, false)
  assert.equal(packets.length, 1)
  const interrupt = sidecar.write('test', '\x03')
  assert.equal(packets.length, 2)
  // Even a lost interrupt ACK must allow a later retry.
  t.mock.timers.tick(4_001)
  assert.equal((await interrupt).ok, false)
  t.mock.timers.tick(1_001)
  const retry = sidecar.write('test', 'z')
  receive({ type: 'response', id: 'test', requestId: packets[2].requestId, ok: true })
  assert.equal((await retry).ok, true)
})

test('large output bursts retain preceding ACK and exit events', async () => {
  const { sidecar, packets, consume } = simulatedSidecar()
  const exits: string[] = []
  sidecar.on('exit', (id) => exits.push(id))
  const pending = sidecar.write('test', 'x')
  consume([
    JSON.stringify({ type: 'response', id: 'test', requestId: packets[0].requestId, ok: true }),
    JSON.stringify({ type: 'exit', id: 'other' }),
    JSON.stringify({ type: 'data', id: 'test', data: 'x'.repeat(2_100_000) }), ''
  ].join('\n'))
  assert.equal((await pending).ok, true)
  assert.deepEqual(exits, ['other'])
})

test('late data and exit from a replaced native session cannot reach its replacement', () => {
  const { sidecar, packets, receive } = simulatedSidecar()
  const options = { id: 'same-widget', shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} }
  const seen: string[] = []
  sidecar.on('data', (_id, data) => seen.push(data))
  sidecar.on('exit', () => seen.push('EXIT'))
  sidecar.spawn(options)
  const old = packets[0].id
  sidecar.spawn(options)
  const current = packets[1].id
  assert.notEqual(old, current)
  receive({ type: 'data', id: old, data: 'stale' })
  receive({ type: 'exit', id: old })
  receive({ type: 'data', id: current, data: 'fresh' })
  assert.deepEqual(seen, ['fresh'])
})

test('session exit resolves outstanding writes immediately and malformed events do not throw', async () => {
  const { sidecar, receive, consume } = simulatedSidecar()
  const pending = sidecar.write('test', 'x')
  consume('null\n42\n{"type":"data","id":"test","data":null}\n')
  receive({ type: 'exit', id: 'test' })
  assert.equal((await pending).ok, false)
})

test('natural session exit releases its wire-id mappings', () => {
  const { sidecar, packets, receive } = simulatedSidecar()
  const id = 'naturally-exited'
  sidecar.spawn({ id, shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} })
  const wireId = packets[0].id
  receive({ type: 'exit', id: wireId })

  const sessions = Reflect.get(sidecar, 'sessions') as Map<string, string>
  const sessionOwners = Reflect.get(sidecar, 'sessionOwners') as Map<string, string>
  assert.equal(sessions.has(id), false)
  assert.equal(sessionOwners.has(wireId), false)
})

test('spawn timeout releases its abandoned wire-id mapping', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sidecar, packets } = simulatedSidecar()
  const id = 'spawn-timeout'
  sidecar.spawn({ id, shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} })
  const wireId = packets[0].id

  t.mock.timers.tick(8_001)

  const sessions = Reflect.get(sidecar, 'sessions') as Map<string, string>
  const sessionOwners = Reflect.get(sidecar, 'sessionOwners') as Map<string, string>
  assert.equal(sessions.has(id), false)
  assert.equal(sessionOwners.has(wireId), false)
})

test('failed backend cannot accept a new spawn or falsely recover the terminal', async () => {
  const { sidecar, packets } = simulatedSidecar()
  Reflect.set(sidecar, 'backendFailureSignalled', true)
  assert.equal(sidecar.spawn({ id: 'test', shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} }).ok, false)
  assert.equal((await sidecar.write('test', 'x')).ok, false)
  assert.equal(packets.length, 0)
})

test('engine spawn rejection reaches the terminal owner', () => {
  const { sidecar, packets, receive } = simulatedSidecar()
  const errors: Array<{ id: string; message: string }> = []
  sidecar.on('spawn-error', (id, error) => errors.push({ id, message: error.message }))
  const id = 'spawn-failure'
  assert.equal(sidecar.spawn({ id, shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} }).ok, true)

  receive({ type: 'response', id: packets[0].id, ok: false, error: 'invalid working directory' })
  assert.deepEqual(errors, [{ id, message: 'invalid working directory' }])
})

/**
 * These exercise the real compiled engine binary (native/target/**), the
 * same one TerminalManager uses in production. If it is not built in this
 * environment, RustPtySidecar.create() returns null and the suite skips
 * rather than failing — the node-pty fallback path is covered elsewhere.
 */
function withSidecar(run: (sidecar: RustPtySidecar) => Promise<void>) {
  return async () => {
    const sidecar = createRustPtySidecar()
    if (!sidecar) {
      // eslint-disable-next-line no-console
      console.warn('[test] rust engine binary unavailable; skipping')
      return
    }
    try {
      await run(sidecar)
    } finally {
      sidecar.close()
    }
  }
}

describe('RustPtySidecar', () => {
  test(
    'write() resolves true only once the engine acknowledges it',
    withSidecar(async (sidecar) => {
      const id = `write-ack-${Date.now()}`
      const spawned = sidecar.spawn({ id, shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} })
      assert.equal(spawned.ok, true)

      const result = await sidecar.write(id, 'echo hi\r')
      assert.equal(result.ok, true)

      sidecar.dispose(id)
    })
  )

  test(
    'write() to a session the engine does not know about fails instead of reporting success',
    withSidecar(async (sidecar) => {
      // No spawn() for this id: the engine has never heard of it.
      const result = await sidecar.write(`never-spawned-${Date.now()}`, 'ls\n')
      assert.equal(result.ok, false)
      assert.ok((result as { error: string }).error)
    })
  )

  test(
    'a write in flight when the engine exits fails rather than hanging forever',
    withSidecar(async (sidecar) => {
      const id = `exit-race-${Date.now()}`
      const spawned = sidecar.spawn({ id, shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} })
      assert.equal(spawned.ok, true)

      const pending = sidecar.write(id, 'x')
      sidecar.close()

      const result = await pending
      assert.equal(result.ok, false)
    })
  )
})
