#!/usr/bin/env node
// Golden fixture for block 3: the observable answers of the lock manager, the
// version registry and resource-id normalisation, recorded from the real
// TypeScript implementations.
//
// The clock is stepped explicitly rather than slept through, so expiry is
// exercised deterministically and the Rust side can replay the same timeline.
//
// Regenerate with:  node scripts/gen-flow-fixture.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LockManager } from '../src/main/core/locks.ts'
import { VersionRegistry } from '../src/main/core/versioned.ts'
import { fileResource, parseResource, isResourceId } from '../src/main/core/resources.ts'
import { CommandError } from '../src/main/core/types.ts'

let clock = 1_000_000
const locks = new LockManager({ now: () => clock })

type Step = { at: number; call: string; ok: boolean; result?: unknown; code?: string; message?: string }
const lockSteps: Step[] = []

function record(call: string, run: () => unknown): void {
  try {
    const result = run()
    // Deep-copied on the way in, not stored by reference. LockManager renews a
    // lock by mutating expiresAt in place, so a stored reference would be
    // rewritten by every later heartbeat and the fixture would record the state
    // at serialization time instead of at call time — pinning expectations that
    // were never true.
    lockSteps.push({
      at: clock,
      call,
      ok: true,
      result: result === undefined ? null : structuredClone(result)
    })
  } catch (error) {
    const commandError = error as CommandError & { code?: string }
    lockSteps.push({
      at: clock,
      call,
      ok: false,
      code: commandError.code ?? 'failed',
      message: (error as Error).message
    })
  }
}

// --- locks -----------------------------------------------------------------

record('acquire widget:w1 by alice', () =>
  locks.acquire({ resource: 'widget:w1', actorId: 'alice', ttlMs: 5_000 })
)
// A second actor is refused while the lock is live.
record('acquire widget:w1 by bob', () =>
  locks.acquire({ resource: 'widget:w1', actorId: 'bob', ttlMs: 5_000 })
)
// The holder re-acquiring extends rather than conflicts, and keeps acquiredAt.
clock += 1_000
record('re-acquire widget:w1 by alice', () =>
  locks.acquire({ resource: 'widget:w1', actorId: 'alice', ttlMs: 5_000 })
)
// Not a resource id.
record('acquire nonsense', () => locks.acquire({ resource: 'not-a-resource', actorId: 'alice' }))
record('acquire empty actor', () => locks.acquire({ resource: 'widget:w2', actorId: '   ' }))

// TTL clamping at both ends.
record('acquire widget:w3 ttl 10ms', () =>
  locks.acquire({ resource: 'widget:w3', actorId: 'alice', ttlMs: 10 })
)
record('acquire widget:w4 ttl 1h', () =>
  locks.acquire({ resource: 'widget:w4', actorId: 'alice', ttlMs: 60 * 60_000 })
)

// Implicit locks: taken by the bus, skipped by heartbeat.
record('acquire terminal:t1 implicitly by alice', () =>
  locks.acquire({ resource: 'terminal:t1', actorId: 'alice', ttlMs: 5_000, implicit: true })
)
record('heartbeat alice', () => locks.heartbeat('alice', 9_000))

// An implicit lock re-acquired explicitly is promoted.
record('acquire terminal:t1 explicitly by alice', () =>
  locks.acquire({ resource: 'terminal:t1', actorId: 'alice', ttlMs: 5_000 })
)
record('heartbeat alice again', () => locks.heartbeat('alice', 9_000))

// Release rules.
record('release widget:w1 by bob', () => locks.release('widget:w1', 'bob'))
record('release widget:w1 by alice', () => locks.release('widget:w1', 'alice'))
record('release widget:w1 again', () => locks.release('widget:w1', 'alice'))

// Renew.
record('renew widget:w3 by bob', () => locks.renew('widget:w3', 'bob', 5_000))
record('renew missing', () => locks.renew('widget:nope', 'alice', 5_000))

// Expiry. A fresh lock taken after the heartbeats, so nothing extends it: its
// TTL clamps up to the 1s minimum and it lapses 2s later.
record('acquire note:short by alice ttl 10ms', () =>
  locks.acquire({ resource: 'note:short', actorId: 'alice', ttlMs: 10 })
)
clock += 2_000
record('holder note:short after expiry', () => locks.holder('note:short') ?? null)
// Releasing a lapsed lock as a different actor succeeds: an expired lock is
// absent, not held by a stale owner.
record('release expired note:short by bob', () => locks.release('note:short', 'bob'))
record('list after expiry', () => locks.list())

record('releaseAllFor alice', () => locks.releaseAllFor('alice'))
record('list after releaseAllFor', () => locks.list())

// --- versions --------------------------------------------------------------

const versions = new VersionRegistry('widget')
const versionSteps: { call: string; result: unknown }[] = []
const v = (call: string, result: unknown) => versionSteps.push({ call, result })

v('current unknown', versions.current('a'))
v('bump a', versions.bump('a'))
v('bump a again', versions.bump('a'))
v('current a', versions.current('a'))
v('target a', versions.target('a'))

versions.seed([{ id: 'b', version: 7 }, { id: 'c', version: 0 }, { id: 'd' }])
v('seeded b', versions.current('b'))
v('seeded c floors at 1', versions.current('c'))
v('seeded d defaults to 1', versions.current('d'))
v('size', versions.size())

versions.createOverlay('spec')
v('overlay sees base', versions.current('a', 'spec'))
v('bump in overlay', versions.bump('a', 'spec'))
v('base untouched', versions.current('a'))
v('overlay size', versions.size('spec'))
versions.discard('spec')
v('after discard, overlay falls back to base', versions.current('a', 'spec'))

versions.createOverlay('spec2')
versions.bump('a', 'spec2')
versions.bump('e', 'spec2')
versions.commit('spec2')
v('committed a', versions.current('a'))
v('committed e', versions.current('e'))
v('hasOverlay after commit', versions.hasOverlay('spec2'))

// forget with an overlay that does not exist falls through to the base
versions.forget('a', 'no-such-overlay')
v('forget through a missing overlay hits the base', versions.current('a'))

// --- resource ids ----------------------------------------------------------

const resourceCases = [
  'widget:w1',
  'file:C:/Users/x',
  'nope:1',
  'widget:',
  ':w1',
  'widgetw1',
  'terminal:a:b'
].map((raw) => ({ raw, parsed: parseResource(raw), isResourceId: isResourceId(raw) }))

const fileCases = [
  'C:\\Users\\User\\Desktop\\Project',
  'c:/Users/User/Desktop/Project/',
  '/home/User/Project',
  'relative/Path',
  'D:\\',
  'NoSlashHere'
].map((raw) => ({ raw, id: fileResource(raw) }))

const outFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'native',
  'orcspace-app',
  'tests',
  'fixtures',
  'flow-core.json'
)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(
  outFile,
  JSON.stringify({ lockSteps, versionSteps, resourceCases, fileCases }, null, 2) + '\n',
  'utf8'
)

console.log(`Wrote ${lockSteps.length} lock steps, ${versionSteps.length} version steps,`)
console.log(`  ${resourceCases.length} resource cases, ${fileCases.length} file cases`)
console.log(`  ${outFile}`)
