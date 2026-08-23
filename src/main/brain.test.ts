import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

let userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-brain-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { BrainStore } = await import('./brain.ts')

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})

function reset(): void {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
}

describe('BrainStore Markdown persistence', () => {
  test('create and update persist one note per file', () => {
    reset()
    const store = new BrainStore()
    const note = store.create({ title: 'My Note', content: 'hello', tags: ['a', 'b'] })
    store.dispose()
    const notesDir = join(userData, 'notes')
    const first = fs.readdirSync(notesDir)
    assert.equal(first.length, 1)
    assert.match(fs.readFileSync(join(notesDir, first[0]), 'utf8'), /title: "My Note"/)

    store.update(note.id, { title: 'Renamed Note', content: 'changed' })
    store.dispose()
    const second = fs.readdirSync(notesDir)
    assert.equal(second.length, 1)
    assert.match(fs.readFileSync(join(notesDir, second[0]), 'utf8'), /changed/)
    assert.notEqual(first[0], second[0])
  })

  test('remove, restore, and purge preserve their external behavior', () => {
    reset()
    const store = new BrainStore()
    const note = store.create({ title: 'Trash me' })
    store.remove(note.id)
    store.dispose()
    assert.equal(store.snapshot().notes.length, 0)
    assert.equal(store.trash().length, 1)
    store.restore(note.id)
    store.dispose()
    assert.equal(store.snapshot().notes.length, 1)
    store.remove(note.id)
    store.purge(note.id)
    store.dispose()
    assert.equal(fs.readdirSync(join(userData, 'notes')).length, 0)
  })

  test('migrates the legacy JSON store once', () => {
    reset()
    const legacy = {
      notes: [{ id: 'note-1234-abc', title: 'Legacy', content: 'body', tags: [], createdAt: 1, updatedAt: 2, version: 3 }]
    }
    fs.writeFileSync(join(userData, 'second-brain.json'), JSON.stringify(legacy))
    const store = new BrainStore()
    assert.equal(store.snapshot().notes[0].title, 'Legacy')
    store.dispose()
    assert.equal(fs.existsSync(join(userData, 'second-brain.json')), false)
    assert.equal(fs.existsSync(join(userData, 'second-brain.json.migrated')), true)
    assert.equal(fs.readdirSync(join(userData, 'notes')).length, 1)
  })

  test('emits change after create, update, and delete', () => {
    reset()
    const store = new BrainStore()
    const seen: number[] = []
    store.on('change', (snapshot: { notes: { title: string }[] }) => seen.push(snapshot.notes.length))
    const note = store.create({ title: 'Live' })
    store.update(note.id, { content: 'body' })
    store.remove(note.id)
    store.dispose()
    assert.deepEqual(seen, [1, 1, 0])
  })
})
