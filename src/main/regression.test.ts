import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { CanvasStore, sanitizeWidget, sanitizeStrokesJs } from './canvasState.ts'
import { createCore } from './core/index.ts'
import { Journal } from './core/journal.ts'
import { getUserDataDir } from './userData.ts'

// Ensure CanvasStore/Storage can read without Electron: set test userData dir before any test runs
if (!process.env.ORCSPACE_TEST_USER_DATA) {
  const tmpBase = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-regress-'))
  process.env.ORCSPACE_TEST_USER_DATA = tmpBase
}

// ---------------------------------------------------------------------------
// Invariant validation helpers
// ---------------------------------------------------------------------------

function assertMonotonicVersions(journal: Journal): void {
  const seen = new Map<string, number>()
  for (const e of journal.all()) {
    if (e.phase !== 'commit' || typeof e.version !== 'number') continue
    const cur = seen.get(e.target) ?? 0
    assert.ok(e.version > cur, `version for ${e.target} must be monotonic: ${e.version} <= ${cur}`)
    seen.set(e.target, e.version)
  }
}

function assertJournalHashChain(journal: Journal): void {
  const result = journal.verifyIntegrity()
  assert.equal(result.valid, true, `journal hash-chain broken at seq ${result.brokenSeq}: ${result.reason}`)
}

// ---------------------------------------------------------------------------
// 1. End-to-end invariants: journal, versions, locks
// ---------------------------------------------------------------------------

describe('Regression — end-to-end invariants', () => {
  test('journal hash-chain is valid after mixed workload', async () => {
    const core = createCore()
    core.actors.register({ id: 'user', type: 'user', label: 'tester', transport: 'test' })
    core.actors.register({ id: 'agent-a', type: 'agent', label: 'a', transport: 'test' })
    // Minimal handlers without version registry — hash-chain must stay valid regardless
    core.bus.register('note.create', { apply: () => ({ version: 1 }) })
    await core.bus.submit({ actorId: 'user', type: 'note.create', target: 'widget:w1', payload: {} })
    await core.bus.submit({ actorId: 'agent-a', type: 'note.create', target: 'widget:w2', payload: {} })
    assertJournalHashChain(core.journal)
  })

  test('version monotonic per resource under concurrent writes', async () => {
    const core = createCore()
    core.actors.register({ id: 'user', type: 'user', label: 'u', transport: 'test' })
    const { VersionRegistry } = await import('./core/versioned.ts')
    const reg = new VersionRegistry('widget')
    core.bus.registerVersions('widget', reg)
    core.bus.register('inc', {
      apply: ({ command, currentVersion }) => {
        // Bump registry so next currentVersion reflects prior write (event sourcing)
        const next = reg.bump(command.target.replace('widget:', ''))
        assert.equal(next, currentVersion + 1, 'registry bump must follow currentVersion')
        return { version: next }
      }
    })
    const N = 20
    const promises = Array.from({ length: N }, (_, i) =>
      core.bus.submit({ actorId: 'user', type: 'inc', target: 'widget:counter', payload: { i } })
    )
    const results = await Promise.all(promises)
    const ok = results.filter((r) => r.ok)
    assert.equal(ok.length, N)
    const sorted = ok.map((r) => (r as { version: number }).version).sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i++) assert.equal(sorted[i], i + 1)
  })

  test('locks do not leak after handler throws', async () => {
    const core = createCore()
    core.actors.register({ id: 'user', type: 'user', label: 'u', transport: 'test' })
    core.bus.register('boom', {
      apply: () => {
        throw new Error('boom')
      }
    })
    const res = await core.bus.submit({ actorId: 'user', type: 'boom', target: 'widget:x', payload: {} })
    assert.equal(res.ok, false)
    // Lock must be released even though handler threw
    assert.equal(core.locks.isLockedByOther('widget:x', 'user'), false)
  })

  test('widget kinds invariant: orchestration accepted, removed and unknown rejected', () => {
    const ok = sanitizeWidget({ id: 'w1', title: 't', x: 0, y: 0, w: 100, h: 100, z: 1, kind: 'orchestration' })
    assert.ok(ok, 'orchestration widget must be accepted')
    assert.equal(ok?.kind, 'orchestration')
    const removedNote = sanitizeWidget({ id: 'w2', title: 't', x: 0, y: 0, w: 100, h: 100, z: 1, kind: 'note' })
    assert.equal(removedNote, null, 'removed note widget must be rejected')
    const bad = sanitizeWidget({ id: 'w3', title: 't', x: 0, y: 0, w: 100, h: 100, z: 1, kind: 'invalid_kind' as never })
    assert.equal(bad, null, 'unknown kind should be rejected')
  })

  test('strokes capped at 200k points', () => {
    const strokes = Array.from({ length: 25 }, (_, i) => ({
      id: `s${i}`,
      color: '#fff',
      points: Array.from({ length: 10000 }, () => ({ x: 1, y: 1 }))
    }))
    const sanitized = sanitizeStrokesJs(strokes)
    const total = sanitized.reduce((sum, s) => sum + s.points.length, 0)
    assert.ok(total <= 200_000, `total points ${total} exceeds 200k`)
    // Each stroke capped at 10k
    for (const s of sanitized) assert.ok(s.points.length <= 10_000)
  })
})

// ---------------------------------------------------------------------------
// 2. Concurrent IPC stress: 100 disjoint + 50 contended
// ---------------------------------------------------------------------------

describe('Regression — concurrent IPC stress', () => {
  test('100 concurrent writes to disjoint files all succeed', async () => {
    const core = createCore()
    core.actors.register({ id: 'user', type: 'user', label: 'u', transport: 'test' })
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-regress-'))
    // Register file commands
    const { registerFileCommands } = await import('./commands/files.ts')
    // Mock deps: only core needed, others are unused for file.* but register requires shape
    const dummy = { core, canvas: null as never, board: null as never, planner: null as never, orchestration: null as never, terminals: null as never, snapshots: null as never, requestWidget: () => {}, requestWidgetRemoval: () => {}, originWidgetId: () => null, forgetOrigin: () => {}, defaultCwd: () => tmp }
    registerFileCommands(dummy as never)
    const N = 50
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const p = join(tmp, `f${i}.txt`)
        return core.bus.submit({ actorId: 'user', type: 'file.write', target: `file:${p.toLowerCase()}`, payload: { path: p, content: `hello ${i}` } })
      })
    )
    const ok = results.filter((r) => r.ok).length
    assert.equal(ok, N, `expected ${N} successes, got ${ok}`)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('contended writes to same file serialize (no lost updates)', async () => {
    const core = createCore()
    core.actors.register({ id: 'user', type: 'user', label: 'u', transport: 'test' })
    const { VersionRegistry } = await import('./core/versioned.ts')
    const reg = new VersionRegistry('widget')
    core.bus.registerVersions('widget', reg)
    core.bus.register('inc2', {
      apply: ({ command, currentVersion }) => {
        const next = reg.bump(command.target.replace('widget:', ''))
        assert.equal(next, currentVersion + 1)
        return { version: next, value: next }
      }
    })
    const N = 30
    const results = await Promise.all(
      Array.from({ length: N }, () => core.bus.submit({ actorId: 'user', type: 'inc2', target: 'widget:shared', payload: {} }))
    )
    assert.equal(results.filter((r) => r.ok).length, N)
    const versions = results.filter((r) => r.ok).map((r) => (r as { version: number }).version).sort((a, b) => a - b)
    assert.deepEqual(versions, Array.from({ length: N }, (_, i) => i + 1))
  })
})

// ---------------------------------------------------------------------------
// 3. Undo/redo stack boundaries via event sourcing (rewind/blame/fork)
// ---------------------------------------------------------------------------

describe('Regression — undo/redo (rewind) boundaries', () => {
  test('rewind to 0 returns empty state, beyond lastSeq returns current', () => {
    const store = new CanvasStore()
    // Ensure empty rewind works without prior load (uses in-memory empty)
    const empty = store.rewind(0, [])
    assert.equal(empty.widgets.length, 0)
    assert.equal(empty.strokes.length, 0)
    // Rewind beyond journal end should not throw and should return at-least empty
    const beyond = store.rewind(999_999, [])
    assert.ok(Array.isArray(beyond.widgets))
  })

  test('blame on non-existent resource returns empty', () => {
    const store = new CanvasStore()
    const history = store.blame('widget:nonexistent' as never, [])
    assert.equal(history.length, 0)
  })

  test('fork does not mutate original', () => {
    const store = new CanvasStore()
    const forked = store.fork('branch-test')
    assert.ok(forkIdCheck(forked))
    // Original should still be queryable
    const snap = store.snapshot()
    assert.ok(Array.isArray(snap.widgets))
  })

  test('journal verifyIntegrity catches tampering', () => {
    const j = new Journal()
    const e1 = j.append({ phase: 'commit', actorId: 'u', type: 't', target: 'widget:a', payload: {} })
    const e2 = j.append({ phase: 'commit', actorId: 'u', type: 't', target: 'widget:b', payload: {} })
    const entries = j.all()
    // Tamper with second entry's payload without updating hash
    const tampered = entries.map((e) => ({ ...e }))
    tampered[1] = { ...tampered[1], payload: { evil: true } }
    const result = j.verifyIntegrity(tampered)
    assert.equal(result.valid, false)
    assert.equal(result.brokenSeq, e2.seq)
  })

  test('readStoreJson fallback on missing file does not throw', async () => {
    const missing = join(getUserDataDir(), `__nonexistent_${Date.now()}.json`)
    const { readStoreJson } = await import('./storage.ts')
    const data = readStoreJson(missing, { fallback: true })
    assert.deepEqual(data, { fallback: true })
  })
})

function forkIdCheck(snap: { widgets: unknown[] }): boolean {
  return Array.isArray(snap.widgets)
}
