import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { FileJournalSink, readJournalTail } from './journalSink.ts'
import type { JournalEntry } from './core/types.ts'

function entry(seq: number): JournalEntry {
  return { seq, at: seq, phase: 'commit', actorId: 'user', type: 'note.update', target: 'note:1' }
}

describe('readJournalTail', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('trailing newline does not make lastSeq 0 when only the last line is requested', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-journal-'))
    dirs.push(dir)
    const file = join(dir, 'command-journal.ndjson')
    writeFileSync(file, `${JSON.stringify(entry(41))}\n${JSON.stringify(entry(42))}\n`, 'utf8')

    const tail = readJournalTail(file, 1)
    assert.equal(tail.lastSeq, 42)
    assert.equal(tail.entries.length, 1)
    assert.equal(tail.entries[0].seq, 42)
  })

  test('a torn last line is skipped and the previous valid seq is kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-journal-'))
    dirs.push(dir)
    const file = join(dir, 'command-journal.ndjson')
    writeFileSync(file, `${JSON.stringify(entry(41))}\n{"seq":42,"type":`, 'utf8')

    const tail = readJournalTail(file, 10)
    assert.equal(tail.lastSeq, 41)
    assert.equal(tail.entries.length, 1)
  })

  test('a large journal returns only its newest entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-journal-'))
    dirs.push(dir)
    const file = join(dir, 'command-journal.ndjson')
    const lines = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
      ...entry(index + 1),
      payload: { text: `строка-${index + 1}-${'x'.repeat(100)}` }
    }))
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

    const tail = readJournalTail(file, 25)
    assert.equal(tail.lastSeq, 5_000)
    assert.deepEqual(tail.entries.map((item) => item.seq), Array.from({ length: 25 }, (_, index) => 4_976 + index))
  })
})

describe('FileJournalSink', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('a failed flush keeps the entry and a later flush writes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-journal-'))
    dirs.push(dir)
    const file = join(dir, 'command-journal.ndjson')
    const sink = new FileJournalSink({ file, flushMs: 60_000 })

    sink.append(entry(1))
    mkdirSync(file)
    sink.flush()

    rmSync(file, { recursive: true, force: true })
    sink.flush()

    const text = readFileSync(file, 'utf8')
    assert.match(text, /"seq":1/)
  })

  /**
   * Compaction runs off the main thread now, so this drives it the way the app
   * does — appends arriving while a rotation is in flight — and checks nothing
   * is dropped.
   *
   * The journal is pre-seeded to several megabytes so the rotation's read is
   * slow enough for appends to land during it; with a small file the whole
   * rotation finishes inside one tick and the interleaving never happens.
   */
  test('a rotation under a steady stream of appends loses nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcspace-journal-rotate-'))
    dirs.push(dir)
    const file = join(dir, 'command-journal.ndjson')

    const filler = Array.from({ length: 30_000 }, (_, i) => JSON.stringify(entry(-i - 1))).join('\n')
    writeFileSync(file, filler + '\n', 'utf8')

    const sink = new FileJournalSink({ file, flushMs: 1, maxBytes: 1024 })

    for (let seq = 1; seq <= 400; seq += 1) {
      sink.append(entry(seq))
      if (seq % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 2))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    sink.flush()

    const tail = readJournalTail(file, 10_000)
    const seqs = new Set(tail.entries.map((e) => e.seq))
    const missing: number[] = []
    for (let seq = 1; seq <= 400; seq += 1) {
      if (!seqs.has(seq)) missing.push(seq)
    }
    assert.deepEqual(missing, [], 'no entry may be swallowed by a rotation')
  })
})
