import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

interface SetupOptions {
  packaged?: boolean
  platform?: string
  env?: Record<string, string>
  /** Contents of resources/package-type, when the install has one. */
  packageType?: string
  /** Output of `codesign -dv` for macOS. */
  codesign?: string
  checkResult?: unknown
}

function setup(options: SetupOptions = {}) {
  const { packaged = true, platform = 'win32', env = {}, packageType, codesign = '', checkResult } = options
  const handlers = new Map<string, () => unknown>()
  let checks = 0
  let installs = 0
  let installArgs: unknown[] = []
  let feed: unknown = null
  const opened: string[] = []
  const autoUpdater = Object.assign(new EventEmitter(), {
    autoDownload: undefined as unknown,
    forceDevUpdateConfig: false,
    checkForUpdates: async () => {
      checks++
      return checkResult === undefined ? { downloadPromise: Promise.resolve([]) } : checkResult
    },
    quitAndInstall: (...args: unknown[]) => { installs++; installArgs = args },
    setFeedURL: (options: unknown) => { feed = options }
  })
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const source = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace('export function', 'function')
  const handle = runInNewContext(stripTypeScriptTypes(source) + '\nregisterUpdater()', {
    app: { isPackaged: packaged, getVersion: () => '2.0.1' },
    ipcMain: { handle: (name: string, fn: () => unknown) => handlers.set(name, fn) },
    shell: { openExternal: (url: string) => { opened.push(url); return Promise.resolve() } },
    updater: { autoUpdater },
    process: { platform, env, execPath: '/Applications/OrcSpace.app/Contents/MacOS/OrcSpace', resourcesPath: '/opt/OrcSpace/resources' },
    spawnSync: () => ({ status: codesign ? 0 : 1, stderr: codesign, stdout: '' }),
    readFileSync: (file: string) => {
      if (packageType !== undefined && String(file).endsWith('package-type')) return packageType
      throw new Error('ENOENT')
    },
    join: (...parts: string[]) => parts.join('/'),
    dirname: (path: string) => path.slice(0, path.lastIndexOf('/')),
    console,
    setImmediate: (fn: () => void) => fn(),
    setTimeout: (fn: () => void) => { timers.set(nextTimer, fn); return nextTimer++ },
    clearTimeout: (id: number) => { timers.delete(id) }
  })
  return { autoUpdater, background: () => (handle as { checkInBackground(): void }).checkInBackground(), call: (name: string) => handlers.get(`updates:${name}`)!(),
    feed: () => feed,
    opened,
    counts: () => ({ checks, installs }),
    installArgs: () => installArgs,
    pending: () => timers.size,
    fireTimers: () => { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn() } }
}

const DEVELOPER_ID = ['Authority=Developer ID Application: OrcSpace (ABCDE12345)', 'TeamIdentifier=ABCDE12345', ''].join('\n')
const ADHOC = ['Signature=adhoc', 'TeamIdentifier=not set', ''].join('\n')

test('updates guard concurrent checks and require a complete download to install', async () => {
  const s = setup()
  assert.equal(s.autoUpdater.autoDownload, undefined)
  s.call('state')
  assert.equal(s.autoUpdater.autoDownload, true)
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
  // Silent install: the NSIS wizard must never be shown on an update.
  assert.deepEqual(s.installArgs(), [true, true])
  await Promise.resolve()
})

test('development builds do not check or install', () => {
  const s = setup({ packaged: false })
  assert.equal((s.call('state') as { status: string }).status, 'disabled')
  s.call('check')
  assert.equal(s.call('install'), false)
  assert.deepEqual(s.counts(), { checks: 0, installs: 0 })
})

test('a Developer ID signed macOS build updates itself like Windows', () => {
  const s = setup({ platform: 'darwin', codesign: DEVELOPER_ID })
  s.call('check')
  s.autoUpdater.emit('update-available', { version: '2.0.2' })
  assert.equal(s.autoUpdater.autoDownload, true)
  assert.equal((s.call('state') as { status: string }).status, 'downloading')
  s.autoUpdater.emit('update-downloaded', { version: '2.0.2' })
  assert.equal(s.call('install'), true)
  assert.equal(s.counts().installs, 1)
})

test('an unsigned or ad-hoc macOS build only announces the release and opens its page', () => {
  for (const codesign of [ADHOC, '']) {
    const s = setup({ platform: 'darwin', codesign })
    s.call('check')
    assert.equal(s.autoUpdater.autoDownload, false)
    s.autoUpdater.emit('update-available', { version: '2.0.2' })
    const state = s.call('state') as { status: string; version: string }
    assert.equal(state.status, 'available')
    assert.equal(state.version, '2.0.2')
    assert.equal(s.pending(), 0)
    assert.equal(s.call('install'), true)
    assert.deepEqual(s.opened, ['https://github.com/orcspace/Orcspace-Uptade/releases/latest'])
    assert.equal(s.counts().installs, 0)
  }
})

test('Linux updates in place for an AppImage and a .deb, and by hand otherwise', () => {
  const appImage = setup({ platform: 'linux', env: { APPIMAGE: '/home/u/OrcSpace.AppImage' } })
  appImage.call('check')
  assert.equal(appImage.autoUpdater.autoDownload, true)
  assert.equal(appImage.autoUpdater.forceDevUpdateConfig, false)
  appImage.autoUpdater.emit('update-downloaded', { version: '2.0.2' })
  assert.equal(appImage.call('install'), true)

  const deb = setup({ platform: 'linux', packageType: 'deb' })
  deb.call('check')
  assert.equal(deb.autoUpdater.autoDownload, true)
  assert.equal(deb.autoUpdater.forceDevUpdateConfig, false)

  const tarball = setup({ platform: 'linux' })
  tarball.call('check')
  assert.equal(tarball.autoUpdater.autoDownload, false)
  // Without this electron-updater refuses to read the feed for a non-AppImage.
  assert.equal(tarball.autoUpdater.forceDevUpdateConfig, true)
  tarball.autoUpdater.emit('update-available', { version: '2.0.2' })
  assert.equal((tarball.call('state') as { status: string }).status, 'available')
})

test('a check electron-updater declines to run does not hang as "checking"', async () => {
  const s = setup({ checkResult: null })
  s.call('check')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((s.call('state') as { status: string }).status, 'disabled')
  assert.equal(s.pending(), 0)
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

test('a failed background check stays quiet, a failed manual one does not', () => {
  const quiet = setup()
  quiet.background()
  assert.equal(quiet.counts().checks, 1)
  quiet.autoUpdater.emit('error', new Error('ENOTFOUND github.com'))
  assert.equal((quiet.call('state') as { status: string }).status, 'idle')

  const loud = setup()
  loud.background()
  // The user clicks while the quiet check is still running and takes it over.
  loud.call('check')
  assert.equal(loud.counts().checks, 1)
  loud.autoUpdater.emit('error', new Error('ENOTFOUND github.com'))
  assert.equal((loud.call('state') as { status: string }).status, 'error')
})

test('background checks never interrupt a download, a ready update or development', () => {
  const s = setup()
  s.call('check')
  s.autoUpdater.emit('update-available', { version: '2.0.2' })
  s.background()
  assert.equal(s.counts().checks, 1)
  s.autoUpdater.emit('update-downloaded', { version: '2.0.2' })
  s.background()
  assert.equal(s.counts().checks, 1)
  const dev = setup({ packaged: false })
  dev.background()
  assert.equal(dev.counts().checks, 0)
})

test('a missing mac or linux feed names the platform file as a missing release', () => {
  for (const file of ['latest-mac.yml', 'latest-linux.yml']) {
    const s = setup()
    s.call('check')
    s.autoUpdater.emit('error', new Error(`Cannot find ${file} in the latest release artifacts`))
    assert.match((s.call('state') as { message: string }).message, /No published release/)
  }
})
