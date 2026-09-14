import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkoutRef, createBranch, listBranches, listCommits, readGitStatus, parseHeader, readGitDiffStat } from './git.ts'

function initTempRepo(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'git-picker-test-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  fs.writeFileSync(join(dir, 'a.txt'), 'one\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'first'], { cwd: dir })
  return dir
}

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

describe('git - branch picker', () => {
  it('lists branches with the current one marked', async () => {
    const dir = initTempRepo()
    try {
      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: dir })
      const { branches, current } = await listBranches(dir)
      assert.strictEqual(current, 'feature')
      assert.deepStrictEqual(
        branches.map((b) => b.name).sort(),
        ['feature', 'main']
      )
      assert.strictEqual(branches.find((b) => b.name === 'feature')?.current, true)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('lists commits and filters by query', async () => {
    const dir = initTempRepo()
    try {
      fs.writeFileSync(join(dir, 'b.txt'), 'two\n')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['commit', '-m', 'second commit'], { cwd: dir })
      const all = await listCommits(dir, { limit: 50 })
      assert.strictEqual(all.commits.length, 2)
      assert.ok(all.head.length >= 8)
      const filtered = await listCommits(dir, { limit: 50, query: 'second' })
      assert.strictEqual(filtered.commits.length, 1)
      assert.strictEqual(filtered.commits[0].subject, 'second commit')
      const byHash = await listCommits(dir, { limit: 50, query: filtered.commits[0].short })
      assert.strictEqual(byHash.commits.length, 1)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('blocks checkout while tracked files are dirty', async () => {
    const dir = initTempRepo()
    try {
      execFileSync('git', ['checkout', '-b', 'other'], { cwd: dir })
      execFileSync('git', ['checkout', 'main'], { cwd: dir })
      fs.writeFileSync(join(dir, 'a.txt'), 'dirty\n')
      await assert.rejects(() => checkoutRef(dir, 'other'), /uncommitted tracked changes/)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('lets untracked files ride along on checkout', async () => {
    const dir = initTempRepo()
    try {
      execFileSync('git', ['checkout', '-b', 'other'], { cwd: dir })
      execFileSync('git', ['checkout', 'main'], { cwd: dir })
      fs.writeFileSync(join(dir, 'scratch.txt'), 'untracked\n')
      const switched = await checkoutRef(dir, 'other')
      assert.strictEqual(switched.branch, 'other')
      assert.ok(fs.existsSync(join(dir, 'scratch.txt')))
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('searches beyond the requested limit', async () => {
    const dir = initTempRepo()
    try {
      for (const name of ['two', 'three']) {
        fs.writeFileSync(join(dir, `${name}.txt`), `${name}\n`)
        execFileSync('git', ['add', '-A'], { cwd: dir })
        execFileSync('git', ['commit', '-m', `${name} commit`], { cwd: dir })
      }
      // 'first' is the oldest commit; limit 1 would hide it without deep search.
      const found = await listCommits(dir, { limit: 1, query: 'first' })
      assert.strictEqual(found.commits.length, 1)
      assert.strictEqual(found.commits[0].subject, 'first')
      const unfiltered = await listCommits(dir, { limit: 1 })
      assert.strictEqual(unfiltered.commits.length, 1)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('checks out a clean branch and creates a new one', async () => {
    const dir = initTempRepo()
    try {
      execFileSync('git', ['checkout', '-b', 'other'], { cwd: dir })
      execFileSync('git', ['checkout', 'main'], { cwd: dir })
      const switched = await checkoutRef(dir, 'other')
      assert.strictEqual(switched.branch, 'other')
      const created = await createBranch(dir, 'fresh')
      assert.strictEqual(created.branch, 'fresh')
      const { current } = await listBranches(dir)
      assert.strictEqual(current, 'fresh')
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('rejects invalid refs and branch names', async () => {
    const dir = initTempRepo()
    try {
      await assert.rejects(() => checkoutRef(dir, ''), /required/)
      await assert.rejects(() => checkoutRef(dir, '-evil'), /invalid ref/)
      await assert.rejects(() => createBranch(dir, 'bad..name'), /invalid branch name/)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })
})
