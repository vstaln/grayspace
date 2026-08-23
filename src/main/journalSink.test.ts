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
})
