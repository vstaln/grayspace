import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { registerSettingsIpc } from './settings.ts'
import type { IpcDeps } from './types.ts'

function fakeState(): { settings: { backgroundImage?: string | null }; patchSettings(p: Record<string, unknown>): unknown; publicSettings(): unknown } {
  const settings: { backgroundImage?: string | null } = {}
  return {
    settings,
    patchSettings(patch) {
      if ('backgroundImage' in patch) settings.backgroundImage = patch.backgroundImage as string | null
      return { ...settings }
    },
    publicSettings() {
      return { ...settings }
    }
  }
}

function harness(
  userDataDir: string,
  openFileResult: () => { canceled: boolean; filePaths: string[] }
): {
  call(name: string, ...args: unknown[]): Promise<unknown>
  state: ReturnType<typeof fakeState>
  restore(): void
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const globals = globalThis as typeof globalThis & { __electronMock?: unknown }
  const previousMock = globals.__electronMock
  const previousEnv = process.env.ORCSPACE_TEST_USER_DATA
  globals.__electronMock = {
    ipcMain: {
      handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
      on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn)
    },
    app: { getPath: () => userDataDir },
    dialog: { showOpenDialog: async () => openFileResult() }
  }
  process.env.ORCSPACE_TEST_USER_DATA = userDataDir
  const state = fakeState()
  const deps = {
    state,
    getWindow: () => null
  } as unknown as IpcDeps
  registerSettingsIpc(deps)
  return {
    state,
    async call(name, ...args) {
      const fn = handlers.get(name)
      assert.ok(fn, `no handler registered for ${name}`)
      return await fn({}, ...args)
    },
    restore() {
      globals.__electronMock = previousMock
      if (previousEnv === undefined) delete process.env.ORCSPACE_TEST_USER_DATA
      else process.env.ORCSPACE_TEST_USER_DATA = previousEnv
    }
  }
}

test('a background that fails to load leaves the previous one in place', async () => {
  const userDataDir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-settings-'))
  const sourcesDir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-bg-src-'))
  let nextPick = { canceled: false, filePaths: [''] }
  const h = harness(userDataDir, () => nextPick)
  try {
    const goodSource = join(sourcesDir, 'good.png')
    fs.writeFileSync(goodSource, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    nextPick = { canceled: false, filePaths: [goodSource] }

    const first = (await h.call('settings:pick-background')) as { dataUrl?: string | null; error?: string }
    assert.ok(!first.error, first.error)
    assert.ok(first.dataUrl)
    const firstPath = h.state.settings.backgroundImage
    assert.ok(firstPath && fs.existsSync(firstPath))

    // Second pick points at a source that no longer exists by the time the
    // handler reads it — the copy can never succeed.
    const missingSource = join(sourcesDir, 'gone.png')
    nextPick = { canceled: false, filePaths: [missingSource] }
    const second = (await h.call('settings:pick-background')) as { dataUrl?: string | null; error?: string }
    assert.ok(second.error, 'a copy that cannot succeed should report an error')

    // The old background must still be exactly what it was: the setting
    // still points at it, and the file itself was never deleted.
    assert.equal(h.state.settings.backgroundImage, firstPath)
    assert.ok(fs.existsSync(firstPath!), 'previous background file must survive a failed replacement')
  } finally {
    h.restore()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(sourcesDir, { recursive: true, force: true })
  }
})

test('re-picking the currently active background (a file already inside the background dir) succeeds', async () => {
  const userDataDir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-settings-'))
  const sourcesDir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-bg-src-'))
  let nextPick = { canceled: false, filePaths: [''] }
  const h = harness(userDataDir, () => nextPick)
  try {
    const source = join(sourcesDir, 'good.png')
    fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    nextPick = { canceled: false, filePaths: [source] }

    const first = (await h.call('settings:pick-background')) as { dataUrl?: string | null; error?: string }
    assert.ok(!first.error, first.error)
    const firstPath = h.state.settings.backgroundImage as string

    // Pick the file that is now the active background itself (as if the
    // user opened the file picker inside the app's own background folder).
    nextPick = { canceled: false, filePaths: [firstPath] }
    const second = (await h.call('settings:pick-background')) as { dataUrl?: string | null; error?: string }
    assert.ok(!second.error, second.error)
    assert.ok(second.dataUrl)
  } finally {
    h.restore()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(sourcesDir, { recursive: true, force: true })
  }
})
