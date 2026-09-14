import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseColumnNames, readSqliteTable } from './sqliteRead.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * A real 512-byte-page database written by SQLite itself, holding three
 * checkpointed rows (one with a blob large enough to overflow its page) and a
 * fourth that was committed after the checkpoint, so it exists only in the
 * log. Copied per test because a test must never write into the fixture.
 */
function withFixture(run: (file: string) => void | Promise<void>, wal = true): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'orcspace-sqlite-'))
  const file = join(dir, 'store.db')
  try {
    copyFileSync(join(FIXTURES, 'antigravity-summaries.db'), file)
    if (wal) copyFileSync(join(FIXTURES, 'antigravity-summaries.db-wal'), `${file}-wal`)
    const result = run(file)
    if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }))
    rmSync(dir, { recursive: true, force: true })
    return undefined
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

describe('sqliteRead - column names', () => {
  test('backticked columns keep their order', () => {
    assert.deepEqual(
      parseColumnNames('CREATE TABLE `t` (`a` text,`b` integer NOT NULL DEFAULT 0, c BLOB)'),
      ['a', 'b', 'c']
    )
  })

  test('table constraints take no column slot', () => {
    assert.deepEqual(
      parseColumnNames('CREATE TABLE t (a text, b text, PRIMARY KEY (a, b), FOREIGN KEY (b) REFERENCES u(x))'),
      ['a', 'b']
    )
  })

  test('a type with its own parentheses does not split the column', () => {
    assert.deepEqual(parseColumnNames('CREATE TABLE t (a VARCHAR(20), b NUMERIC(10, 2))'), ['a', 'b'])
  })

  test('a shape with no columns yields nothing rather than a guess', () => {
    assert.deepEqual(parseColumnNames('CREATE TABLE t'), [])
  })
})

describe('sqliteRead - reading a store', () => {
  test('rows come back keyed by column, overflow payloads included', async () => {
    await withFixture(async (file) => {
      const rows = await readSqliteTable(file, 'conversation_summaries')
      assert.deepEqual(
        rows.map((row) => row.title).sort(),
        ['Checkpointed One', 'Killed One', 'Only In The Log', 'Other Folder']
      )
      const checkpointed = rows.find((row) => row.title === 'Checkpointed One')!
      assert.equal(checkpointed.conversation_id, '11111111-1111-4111-8111-111111111111')
      assert.equal(checkpointed.workspace_uris, '["file:///C:/Users/dev/Project"]')
      assert.equal(checkpointed.killed, 0)
      // 1500 bytes at a 512-byte page size only fits by following the chain.
      assert.equal((checkpointed.raw_summary as Uint8Array).length, 1500)
    })
  })

  test('a row committed after the last checkpoint is read from the log', async () => {
    await withFixture(async (file) => {
      const rows = await readSqliteTable(file, 'conversation_summaries')
      assert.ok(rows.some((row) => row.conversation_id === '44444444-4444-4444-8444-444444444444'))
    })
  })

  test('without the log, only what the main file holds is read', async () => {
    await withFixture(async (file) => {
      const rows = await readSqliteTable(file, 'conversation_summaries')
      assert.equal(rows.length, 3)
      assert.ok(!rows.some((row) => row.title === 'Only In The Log'))
    }, false)
  })

  test('a payload budget truncates the row instead of failing it', async () => {
    await withFixture(async (file) => {
      const rows = await readSqliteTable(file, 'conversation_summaries', { maxPayloadBytes: 64 })
      const truncated = rows.find((row) => row.conversation_id === '11111111-1111-4111-8111-111111111111')!
      // The columns before the blob still decode; the blob itself is dropped.
      assert.equal(truncated.title, 'Checkpointed One')
      assert.equal(truncated.raw_summary, null)
    })
  })

  test('a table that is not there, and a file that is not a database, read as empty', async () => {
    await withFixture(async (file) => {
      assert.deepEqual(await readSqliteTable(file, 'no_such_table'), [])
    })
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-sqlite-'))
    try {
      const junk = join(dir, 'junk.db')
      writeFileSync(junk, 'not a database at all')
      assert.deepEqual(await readSqliteTable(junk, 'conversation_summaries'), [])
      assert.deepEqual(await readSqliteTable(join(dir, 'missing.db'), 'conversation_summaries'), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a log for a different database is ignored rather than spliced in', async () => {
    await withFixture(async (file) => {
      writeFileSync(`${file}-wal`, Buffer.alloc(4096, 7))
      const rows = await readSqliteTable(file, 'conversation_summaries')
      assert.equal(rows.length, 3)
    })
  })
})
