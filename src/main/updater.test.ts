import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

function setup(packaged = true, platform = 'win32') {
  const handlers = new Map<string, () => unknown>()
  let checks = 0
  let installs = 0
  let feed: unknown = null
  const autoUpdater = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => { checks++; return { downloadPromise: Promise.resolve([]) } },
    quitAndInstall: () => { installs++ },
    setFeedURL: (options: unknown) => { feed = options }
  })
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const source = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace('export function', 'function')
  runInNewContext(stripTypeScriptTypes(source) + '\nregisterUpdater()', {
    app: { isPackaged: packaged, getVersion: () => '2.0.1' },
    ipcMain: { handle: (name: string, fn: () => unknown) => handlers.set(name, fn) },
    updater: { autoUpdater }, process: { platform }, console,
    setImmediate: (fn: () => void) => fn(),
    setTimeout: (fn: () => void) => { timers.set(nextTimer, fn); return nextTimer++ },
    clearTimeout: (id: number) => { timers.delete(id) }
  })
  return { autoUpdater, call: (name: string) => handlers.get(`updates:${name}`)!(),
    feed: () => feed,
    counts: () => ({ checks, installs }),
    pending: () => timers.size,
    fireTimers: () => { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn() } }
}

test('updates guard concurrent checks and require a complete download to install', async () => {
  const s = setup()
  assert.equal(JSON.stringify(s.feed()), JSON.stringify({ provider: 'github', owner: 'orcspace', repo: 'Orcspace-Uptade', releaseType: 'release' }))
  s.call('install')
  s.call('check')
  s.call('check')
  assert.equal(s.counts().checks, 1)
  s.autoUpdater.emit('update-available', { version: '2.0.2' })
  s.autoUpdater.emit('download-progress', { percent: 42 })
  assert.equal((s.call('state') as { percent: number }).percent, 42)
  assert.equal(s.call('install'), false)
  s.autoUpdater.emit('update-downloaded', { version: '2.0.2' })
  assert.equal(s.call('install'), true)
  assert.equal(s.call('install'), false)
  assert.equal(s.counts().installs, 1)
  await Promise.resolve()
})

test('development and unsigned macOS builds do not check or install', () => {
  for (const s of [setup(false), setup(true, 'darwin')]) {
    s.call('check')
    assert.equal(s.call('install'), false)
    assert.deepEqual(s.counts(), { checks: 0, installs: 0 })
  }
})

test('an update error can be retried', () => {
  const s = setup()
  s.call('check')
  s.autoUpdater.emit('error', new Error('offline'))
  assert.equal((s.call('state') as { status: string }).status, 'error')
  s.call('check')
  assert.equal(s.counts().checks, 2)
  s.autoUpdater.emit('update-not-available')
  assert.equal((s.call('state') as { status: string }).status, 'current')
})

test('a check that never answers ends in a retryable error, and a finished one leaves no timer', () => {
  const s = setup()
  s.call('check')
  assert.equal(s.pending(), 1)
  s.fireTimers()
  const stalled = s.call('state') as { status: string; message: string }
  assert.equal(stalled.status, 'error')
  assert.match(stalled.message, /connection|try again/i)
  s.call('check')
  s.autoUpdater.emit('update-not-available')
  assert.equal(s.pending(), 0)
  assert.equal((s.call('state') as { status: string }).status, 'current')
})

test('a missing release is reported as a missing release, not as a network problem', () => {
  const s = setup()
  s.call('check')
  s.autoUpdater.emit('error', new Error('HttpError: 404 Not Found loading latest.yml'))
  assert.match((s.call('state') as { message: string }).message, /No published release/)
})

test('a download that goes silent fails instead of hanging at a percentage', () => {
  const s = setup()
  s.call('check')
  s.autoUpdater.emit('update-available', { version: '2.0.4' })
  s.autoUpdater.emit('download-progress', { percent: 30 })
  s.fireTimers()
  const state = s.call('state') as { status: string; percent?: number }
  assert.equal(state.status, 'error')
  assert.equal(state.percent, undefined)
})
