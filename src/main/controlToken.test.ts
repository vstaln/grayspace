import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

/**
 * `controlToken` caches in module scope and reads its directory from
 * `getUserDataDir`, so each case gets a fresh module instance pointed at its
 * own directory. Importing with a cache-busting query is the cheapest way to
 * do that without adding a reset hook that only tests would use.
 */
async function freshModule(dir: string): Promise<{
  controlToken: () => string
  controlTokenPersistError: () => string | null
  tokenFile: () => string
}> {
  process.env.ORCSPACE_TEST_USER_DATA = dir
  return (await import(`./controlToken.ts?case=${encodeURIComponent(dir)}`)) as never
}

describe('controlToken', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    delete process.env.ORCSPACE_TEST_USER_DATA
  })

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-token-'))
    dirs.push(dir)
    return dir
  }

  test('a fresh token is written to disk and readable back', async () => {
    const dir = scratch()
    const mod = await freshModule(dir)

    const token = mod.controlToken()
    assert.equal(token.length, 64, 'a 32-byte token in hex')
    assert.equal(readFileSync(mod.tokenFile(), 'utf8').trim(), token)
    assert.equal(mod.controlTokenPersistError(), null)
  })

  test('the token file is not world readable', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permission bits do not apply on Windows')
      return
    }
    const dir = scratch()
    const mod = await freshModule(dir)
    mod.controlToken()

    const mode = statSync(mod.tokenFile()).mode & 0o777
    assert.equal(mode & 0o077, 0, `the token must not be group or world readable, got ${mode.toString(8)}`)
  })

  /**
   * The failure this guards is silent by construction: the server keeps a
   * token only it knows, every client reads the file and gets something else,
   * and the resulting 401 says nothing about a disk problem. The write failure
   * has to leave a trace that the 401 can point at.
   */
  test('a token that could not be written is reported rather than used silently', async () => {
    const dir = scratch()
    const mod = await freshModule(dir)
    // A directory where the file belongs: writeFileSync cannot replace it.
    mkdirSync(mod.tokenFile(), { recursive: true })

    const token = mod.controlToken()

    assert.equal(token.length, 64, 'the app still gets a token so the window works')
    const reported = mod.controlTokenPersistError()
    assert.ok(reported, 'the failure must be recorded')
    assert.notEqual(reported, '', 'and must carry the reason')
  })

  test('an existing token is reused rather than regenerated', async () => {
    const dir = scratch()
    const first = await freshModule(dir)
    const original = first.controlToken()

    const second = await freshModule(dir)
    assert.equal(second.controlToken(), original, 'restarting must not invalidate live agents')
  })

  test('a truncated token file is replaced rather than trusted', async () => {
    const dir = scratch()
    const mod = await freshModule(dir)
    const file = mod.tokenFile()
    mod.controlToken()

    // Simulate a torn write: too short to be a real token.
    rmSync(file)
    const shortened = await freshModule(dir)
    writeFileSync(file, 'tooshort', 'utf8')
    const replacement = shortened.controlToken()
    assert.equal(replacement.length, 64, 'a short token must not be accepted')
  })
})
