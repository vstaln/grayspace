import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { pruneScratch, saveBytesToScratch, scratchDir, SCRATCH_TTL_MS } from './media.ts'


function ageFile(path: string, msOld: number): void {
  const past = new Date(Date.now() - msOld)
  fs.utimesSync(path, past, past)
}

describe('pruneScratch', () => {
  test('deletes files older than the TTL, keeps fresh ones', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-clipboard-test-'))
    try {
      const stale = join(dir, 'stale.png')
      const fresh = join(dir, 'fresh.png')
      fs.writeFileSync(stale, 'stale')
      fs.writeFileSync(fresh, 'fresh')
      ageFile(stale, SCRATCH_TTL_MS + 60_000)

      pruneScratch(dir)

      assert.equal(fs.existsSync(stale), false)
      assert.equal(fs.existsSync(fresh), true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing directory is a no-op, not a throw', () => {
    assert.doesNotThrow(() => pruneScratch(join(os.tmpdir(), 'orcspace-clipboard-does-not-exist')))
  })
})

describe('saveBytesToScratch', () => {
  test('sweeps stale scratch files left over from past pastes — they never linger forever', () => {
    const dir = scratchDir()
    fs.mkdirSync(dir, { recursive: true })
    const leftover = join(dir, 'leftover-from-a-past-session.png')
    fs.writeFileSync(leftover, 'old paste nobody ever cleaned up')
    ageFile(leftover, SCRATCH_TTL_MS + 60_000)

    try {
      const saved = saveBytesToScratch(Buffer.from('a fresh paste'), 'png')

      assert.equal(fs.existsSync(leftover), false, 'a stale scratch file must not survive the next paste')
      assert.equal(fs.existsSync(saved.path), true)
    } finally {
      fs.rmSync(leftover, { force: true })


      for (const name of fs.readdirSync(dir)) {
        if (fs.readFileSync(join(dir, name)).toString() === 'a fresh paste') fs.rmSync(join(dir, name), { force: true })
      }
    }
  })
})
