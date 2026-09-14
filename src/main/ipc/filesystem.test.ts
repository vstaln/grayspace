import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { registerFilesystemIpc } from './filesystem.ts'
import type { IpcDeps } from './types.ts'

function harness(workspaceDir: string): { call(name: string, ...args: unknown[]): Promise<unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const globals = globalThis as typeof globalThis & { __electronMock?: unknown }
  const previous = globals.__electronMock
  globals.__electronMock = {
    ipcMain: {
      handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
      on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn)
    }
  }
  const deps = {
    core: {} as never,
    getWorkspaceDir: () => workspaceDir
  } as unknown as IpcDeps
  registerFilesystemIpc(deps)
  const restore = (): void => {
    globals.__electronMock = previous
  }
  return {
    async call(name, ...args) {
      try {
        const fn = handlers.get(name)
        assert.ok(fn, `no handler registered for ${name}`)
        return await fn({}, ...args)
      } finally {
        restore()
      }
    }
  }
}

test('fs:list reports a symlinked directory as a directory, not a file', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-fs-'))
  try {
    const realDir = join(dir, 'real-dir')
    fs.mkdirSync(realDir)
    fs.writeFileSync(join(realDir, 'inside.txt'), 'hi')
    const linkPath = join(dir, 'link-to-dir')
    try {
      fs.symlinkSync(realDir, linkPath, 'junction')
    } catch (err) {
      // Symlink/junction creation can be blocked by policy in some
      // environments; the fix cannot be exercised there.
      console.warn('[test] skipping: could not create a directory symlink', err)
      return
    }

    const res = (await harness(dir).call('fs:list', dir)) as {
      items: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>
    }
    const entry = res.items.find((i) => i.name === 'link-to-dir')
    assert.ok(entry, 'symlink entry should be listed')
    assert.equal(entry!.isSymbolicLink, true)
    assert.equal(entry!.isDirectory, true, 'a directory symlink must resolve as a directory')
    assert.equal(entry!.isFile, false)

    // And it must actually be navigable: listing through the link works
    // the same as listing the real directory.
    const nested = (await harness(dir).call('fs:list', linkPath)) as {
      items: Array<{ name: string }>
    }
    assert.ok(nested.items.some((i) => i.name === 'inside.txt'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fs:list marks a broken symlink as neither file nor directory instead of guessing', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-fs-'))
  try {
    const missingTarget = join(dir, 'does-not-exist')
    const linkPath = join(dir, 'broken-link')
    try {
      fs.symlinkSync(missingTarget, linkPath, 'junction')
    } catch (err) {
      console.warn('[test] skipping: could not create a symlink', err)
      return
    }

    const res = (await harness(dir).call('fs:list', dir)) as {
      items: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>
    }
    const entry = res.items.find((i) => i.name === 'broken-link')
    assert.ok(entry)
    assert.equal(entry!.isSymbolicLink, true)
    assert.equal(entry!.isDirectory, false)
    assert.equal(entry!.isFile, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fs:list flags truncation so the UI can say the folder was not fully listed', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-fs-'))
  try {
    for (let i = 0; i < 2_005; i += 1) {
      fs.writeFileSync(join(dir, `f-${String(i).padStart(5, '0')}.txt`), '')
    }
    const res = (await harness(dir).call('fs:list', dir)) as { items: unknown[]; truncated?: boolean }
    assert.equal(res.truncated, true)
    assert.equal(res.items.length, 2_000)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fs:open-path blocks executable and script extensions', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-fs-'))
  try {
    const scriptPath = join(dir, 'run.mjs')
    fs.writeFileSync(scriptPath, 'console.log("bad")')
    const res = (await harness(dir).call('fs:open-path', scriptPath)) as { error?: string; ok?: boolean }
    assert.equal(res.ok, undefined)
    assert.equal(res.error, 'Executable files cannot be opened from here')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
