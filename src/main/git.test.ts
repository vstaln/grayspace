import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { readGitStatus, parseHeader } from './git.ts'

describe('git - parseHeader', () => {
  it('parses branch with upstream and ahead/behind counts', () => {
    const result = parseHeader('## main...origin/main [ahead 2, behind 1]')
    assert.strictEqual(result.branch, 'main')
    assert.strictEqual(result.upstream, 'origin/main')
    assert.strictEqual(result.ahead, 2)
    assert.strictEqual(result.behind, 1)
  })

  it('parses simple local branch without upstream', () => {
    const result = parseHeader('## feature-xyz')
    assert.strictEqual(result.branch, 'feature-xyz')
    assert.strictEqual(result.upstream, undefined)
    assert.strictEqual(result.ahead, 0)
    assert.strictEqual(result.behind, 0)
  })

  it('parses initial repo state before first commit', () => {
    const result = parseHeader('## No commits yet on master')
    assert.strictEqual(result.branch, 'master')
  })

  it('handles empty header safely', () => {
    const result = parseHeader('')
    assert.deepStrictEqual(result, {})
  })
})

describe('git - readGitStatus', () => {
  it('returns empty status for undefined cwd', async () => {
    const result = await readGitStatus(undefined)
    assert.strictEqual(result.repo, false)
    assert.strictEqual(result.ahead, 0)
    assert.strictEqual(result.behind, 0)
  })

  it('returns repo: false for non-git directory', async () => {
    const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'non-git-test-'))
    try {
      const result = await readGitStatus(tempDir)
      assert.strictEqual(result.repo, false)
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
    }
  })

  it('handles git status lookup safely without throwing', async () => {
    const result = await readGitStatus(process.cwd())
    assert.ok(typeof result.repo === 'boolean')
    assert.strictEqual(typeof result.ahead, 'number')
    assert.strictEqual(typeof result.behind, 'number')
    assert.strictEqual(typeof result.modified, 'number')
    assert.ok(result.readAt > 0)
  })
})
