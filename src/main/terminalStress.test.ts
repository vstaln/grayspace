import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { createRustPtySidecar, type RustPtySidecar } from './rustPtySidecar.ts'
import { defaultShell } from './config.ts'

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
async function until(predicate: () => boolean, message: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) await delay(25)
  assert.ok(predicate(), message)
}
function running(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function engineChild(sidecar: RustPtySidecar): ChildProcessWithoutNullStreams {
  return Reflect.get(sidecar, 'child')
}
function observe(sidecar: RustPtySidecar) {
  const output = new Map<string, string>()
  const pids = new Map<string, number>()
  const queryTail = new Map<string, string>()
  let received = 0
  let replacements = 0
  sidecar.on('data', (id: string, data: string) => {
    // Emulate xterm's cursor-position reply required by Windows ConPTY.
    const queries = (queryTail.get(id) ?? '') + data
    if (queries.includes('\x1b[6n')) void sidecar.write(id, '\x1b[1;1R')
    queryTail.set(id, queries.slice(-3))
    received += Buffer.byteLength(data)
    replacements += data.split('\ufffd').length - 1
    const tail = ((output.get(id) ?? '') + data).slice(-128_000)
    output.set(id, tail)
    const plain = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    const pid = plain.match(/ORC_STRESS_PID=(\d+)/)?.[1]
    if (pid) pids.set(id, Number(pid))
  })
  return { output, pids, bytes: () => received, replacements: () => replacements }
}
async function launch(sidecar: RustPtySidecar, id: string, mode: string) {
  assert.ok(sidecar.spawn({ id, shell: defaultShell(), cols: 120, rows: 32, cwd: process.cwd(), env: {} }).ok)
  const script = resolve('scripts/terminal-stress-child.cjs')
  assert.ok((await sidecar.write(id, `"${process.execPath}" "${script}" ${mode}\r`)).ok)
}
async function cleanup(sidecar: RustPtySidecar, pids: Iterable<number>) {
  sidecar.close()
  await until(() => engineChild(sidecar).exitCode !== null || engineChild(sidecar).signalCode !== null,
    'test engine must exit', 8_000)
  // Own test workloads only, including cleanup after a failed regression.
  for (const pid of pids) {
    if (running(pid)) { try { process.kill(pid) } catch {} }
  }
}

test('real engine handles concurrent unicode output, input and session reuse', { timeout: 30_000 }, async (t) => {
  const sidecar = createRustPtySidecar()
  if (!sidecar) return t.skip('build the native engine to run stress checks')
  const observed = observe(sidecar)
  try {
    await Promise.all(['load-a', 'load-b', 'load-c'].map((id) => launch(sidecar, id, 'unicode')))
    await launch(sidecar, 'control', 'quiet')
    await until(() => observed.pids.size === 4, 'all workloads started')
    const latencies: number[] = []
    for (let i = 0; i < 30; i++) {
      const start = performance.now()
      assert.ok((await sidecar.write('control', '')).ok)
      latencies.push(performance.now() - start)
      await delay(10)
    }
    await until(() => ['load-a', 'load-b', 'load-c'].every((id) => observed.output.get(id)?.includes('ORC_STRESS_DONE')),
      'all unicode workloads finished')
    assert.ok(observed.bytes() > 6_000_000)
    assert.equal(observed.replacements(), 0, 'UTF-8 must survive arbitrary pipe boundaries')
    assert.ok(Math.max(...latencies) < 2_000, 'input ACK remains responsive under load')
    for (let i = 0; i < 8; i++) {
      assert.ok(sidecar.dispose('load-a').ok)
      assert.ok(sidecar.spawn({ id: 'load-a', shell: defaultShell(), cols: 80, rows: 24, cwd: process.cwd(), env: {} }).ok)
      assert.ok((await sidecar.write('load-a', `echo REUSE_${i}\r`)).ok)
    }
    await until(() => observed.output.get('load-a')?.includes('REUSE_7') === true, 'replacement session accepts input')
    t.diagnostic(`received=${observed.bytes()} bytes; max input ACK=${Math.max(...latencies).toFixed(1)}ms`)
  } finally {
    await cleanup(sidecar, observed.pids.values())
  }
})

for (const mode of ['close', 'crash'] as const) {
  test(`Windows engine ${mode} leaves no test child running`, { timeout: 20_000, skip: process.platform !== 'win32' }, async (t) => {
    const sidecar = createRustPtySidecar()
    if (!sidecar) return t.skip('native engine unavailable')
    const observed = observe(sidecar)
    try {
      await launch(sidecar, 'owned-child', 'quiet')
      await until(() => observed.pids.has('owned-child'), 'test child PID observed')
      const pid = observed.pids.get('owned-child')!
      assert.ok(running(pid))
      if (mode === 'crash') engineChild(sidecar).kill()
      else sidecar.close()
      await until(() => !running(pid), `test child ${pid} survived engine ${mode}`, 8_000)
    } finally {
      if (!observed.pids.size) t.diagnostic(JSON.stringify([...observed.output].map(([id, data]) => [id, data.slice(-2000)])))
      await cleanup(sidecar, observed.pids.values())
    }
  })
}

test('a blocked output consumer cannot prevent disposing a flooding terminal', { timeout: 20_000 }, async (t) => {
  const sidecar = createRustPtySidecar()
  if (!sidecar) return t.skip('native engine unavailable')
  const observed = observe(sidecar)
  try {
    await launch(sidecar, 'flood', 'flood')
    await until(() => observed.pids.has('flood'), 'flood process started')
    const pid = observed.pids.get('flood')!
    engineChild(sidecar).stdout.pause()
    await delay(750)
    assert.ok(sidecar.dispose('flood').ok)
    await until(() => !running(pid), 'dispose must work without stdout draining', 3_000)
    engineChild(sidecar).stdout.resume()
    await launch(sidecar, 'survivor', 'quiet')
    await until(() => observed.pids.has('survivor'), 'engine remains usable after output stalls')
  } finally {
    engineChild(sidecar).stdout.resume()
    await cleanup(sidecar, observed.pids.values())
  }
})
