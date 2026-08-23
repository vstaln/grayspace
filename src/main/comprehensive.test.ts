import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import { join } from 'node:path'
import * as os from 'node:os'
import { after, describe, test, beforeEach, afterEach } from 'node:test'

// Set test user data dir at module level - matching brain.test.ts pattern
const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

import { parseWikiLinks } from './brain.ts'
import { reindexJs } from './brain.ts'
import { BrainStore } from './brain.ts'
import { CoordinationStore } from './coordination.ts'
import { LockManager } from './core/index.ts'

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})

// ---- Brain parseWikiLinks tests ----
describe('parseWikiLinks', () => {
  test('extracts simple wiki links [[Title]]', () => {
    const result = parseWikiLinks('Check out [[Note Title]] for more info')
    assert.deepStrictEqual(result, ['Note Title'])
  })

  test('extracts wiki links with aliases [[Title|Alias]] - only title part kept', () => {
    const result = parseWikiLinks('[[Note Title|Alias]] is the link')
    assert.deepStrictEqual(result, ['Note Title'])
  })

  test('extracts multiple wiki links from same content', () => {
    const result = parseWikiLinks('[[A]] and [[B]] and [[C]]')
    assert.deepStrictEqual(result.sort(), ['A', 'B', 'C'])
  })

  test('handles empty string content', () => {
    const result = parseWikiLinks('')
    assert.deepStrictEqual(result, [])
  })

  test('handles content with no links', () => {
    const result = parseWikiLinks('Just plain text without links')
    assert.deepStrictEqual(result, [])
  })

  test('handles multiline content with links scattered', () => {
    const content = `First line [[Link1]]
Second line [[Link2]] more text
[[Link1]] duplicate should be deduplicated`
    const result = parseWikiLinks(content)
    assert.deepStrictEqual(result.sort(), ['Link1', 'Link2'])
  })
})

// ---- Brain reindex tests ----
describe('reindexJs', () => {
  test('resolves wiki links to note IDs when syntax is wiki', () => {
    const notes = [
      { id: 'n1', title: 'Alpha', content: 'see [[Beta]]', alive: true },
      { id: 'n2', title: 'Beta', content: 'world', alive: true }
    ]
    const input = notes.map(n => ({ id: n.id, title: n.title, content: n.content, alive: n.alive }))
    const result = reindexJs(input, 'wiki')
    assert.ok(result[0].links.includes('n2'), 'Alpha should link to Beta via wiki link')
  })

  test('does not resolve links to self (id !== note.id)', () => {
    const notes = [
      { id: 'n1', title: 'Alpha', content: '[[Alpha]] self-ref', alive: true }
    ]
    const input = notes.map(n => ({ id: n.id, title: n.title, content: n.content, alive: n.alive }))
    const result = reindexJs(input, 'wiki')
    assert.ok(!result[0].links.includes('n1'), 'should not link to self')
  })

  test('dollar syntax $Title is not used when syntax is wiki', () => {
    const notes = [
      { id: 'n1', title: 'Alpha', content: '$Alpha', alive: true }
    ]
    const input = notes.map(n => ({ id: n.id, title: n.title, content: n.content, alive: n.alive }))
    const result = reindexJs(input, 'wiki')
    assert.ok(result[0].links.length === 0, 'dollar links should not appear with wiki syntax')
  })
})

// ---- BrainStore create/update/search tests ----
describe('BrainStore create update search', () => {
  let savedUserData: string

  beforeEach(() => {
    savedUserData = process.env.ORCSPACE_TEST_USER_DATA ?? ''
    const newUserData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-brain-test-'))
    process.env.ORCSPACE_TEST_USER_DATA = newUserData
  })

  afterEach(() => {
    if (savedUserData) {
      process.env.ORCSPACE_TEST_USER_DATA = savedUserData
    } else {
      delete process.env.ORCSPACE_TEST_USER_DATA
    }
  })

  test('create note and persist to markdown', () => {
    const store = new BrainStore()
    const note = store.create({ title: 'My Note', content: 'hello world', tags: ['tag1', 'tag2'] })
    assert.ok(note.id, 'note should have id')
    assert.equal(note.title, 'My Note')
    assert.deepStrictEqual(note.tags, ['tag1', 'tag2'])
    assert.ok(note.content.includes('hello world'), 'note content should include hello world')
    store.dispose()
  })

  test('update note title and content', () => {
    const store = new BrainStore()
    const note = store.create({ title: 'Original', content: 'old', tags: [] })
    store.update(note.id, { title: 'Renamed', content: 'new content', tags: ['new'] })
    const snapshot = store.snapshot()
    const updated = snapshot.notes.find(n => n.id === note.id)
    assert.ok(updated)
    assert.equal(updated.title, 'Renamed')
    assert.equal(updated.content, 'new content')
    assert.deepStrictEqual(updated.tags, ['new'])
    store.dispose()
  })

  test('search finds notes by title content tags', () => {
    const store = new BrainStore()
    store.create({ title: 'Alpha Project', content: 'hello', tags: ['work'] })
    store.create({ title: 'Beta Personal', content: 'world', tags: ['home'] })
    
    const results = store.search('Alpha')
    assert.equal(results.length, 1, 'should find Alpha Project')
    assert.equal(results[0].title, 'Alpha Project')
    
    const results2 = store.search('work')
    assert.equal(results2.length, 1, 'should find by tag work')
    assert.equal(results2[0].title, 'Alpha Project')
    
    const results3 = store.search('hello')
    assert.equal(results3.length, 1, 'should find by content hello')
    assert.equal(results3[0].title, 'Alpha Project')
    
    store.dispose()
  })

  test('search with empty query returns all notes', () => {
    const store = new BrainStore()
    store.create({ title: 'Note1', content: 'a', tags: [] })
    store.create({ title: 'Note2', content: 'b', tags: [] })
    const all = store.search('')
    assert.equal(all.length, 2, 'should return all notes')
    store.dispose()
  })
})

// ---- BrainStore trash restore purge tests ----
describe('BrainStore trash restore purge', () => {
  let savedUserData: string

  beforeEach(() => {
    savedUserData = process.env.ORCSPACE_TEST_USER_DATA ?? ''
    const newUserData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-brain-trash-'))
    process.env.ORCSPACE_TEST_USER_DATA = newUserData
  })

  afterEach(() => {
    if (savedUserData) {
      process.env.ORCSPACE_TEST_USER_DATA = savedUserData
    } else {
      delete process.env.ORCSPACE_TEST_USER_DATA
    }
  })

  test('remove soft-deletes note, restore brings it back', () => {
    const store = new BrainStore()
    const note = store.create({ title: 'Trash me' })
    store.remove(note.id)
    assert.equal(store.snapshot().notes.length, 0, 'removed notes not in snapshot')
    assert.equal(store.trash().length, 1, 'note in trash')
    const restored = store.restore(note.id)
    assert.equal(restored.deletedAt, undefined, 'restored note has no deletedAt')
    assert.equal(store.snapshot().notes.length, 1, 'note back in snapshot')
    store.dispose()
  })

  test('purge permanently deletes note', () => {
    const store = new BrainStore()
    const note = store.create({ title: 'Purge me' })
    store.remove(note.id)
    store.purge(note.id)
    assert.equal(store.snapshot().notes.length, 0)
    store.dispose()
  })
})

// ---- CoordinationStore task claiming tests ----
describe('CoordinationStore task claiming and locks', () => {
  let savedUserData: string

  beforeEach(() => {
    savedUserData = process.env.ORCSPACE_TEST_USER_DATA ?? ''
    const newUserData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-coord-test-'))
    process.env.ORCSPACE_TEST_USER_DATA = newUserData
  })

  afterEach(() => {
    if (savedUserData) {
      process.env.ORCSPACE_TEST_USER_DATA = savedUserData
    } else {
      delete process.env.ORCSPACE_TEST_USER_DATA
    }
  })

  test('createTask basic creates task with queued state', () => {
    const store = new CoordinationStore(new LockManager())
    const task = store.createTask({
      title: 'Test Task',
      createdBy: 'user',
      state: 'backlog'
    })
    assert.equal(task.title, 'Test Task')
    assert.equal(task.state, 'backlog')
    assert.equal(task.assignee, undefined)
    assert.equal(task.createdBy, 'user')
    assert.ok(task.id.startsWith('task-'))
    store.dispose()
  })

  test('createTask with files', () => {
    const store = new CoordinationStore(new LockManager())
    const task = store.createTask({
      title: 'Task with Files',
      createdBy: 'user',
      files: ['/path/to/file1.ts', '/path/to/file2.ts']
    })
    assert.deepStrictEqual(task.files, ['/path/to/file1.ts', '/path/to/file2.ts'])
    store.dispose()
  })

  test('createTask defaults state to queued', () => {
    const store = new CoordinationStore(new LockManager())
    const task = store.createTask({
      title: 'Default State',
      createdBy: 'user'
    })
    assert.equal(task.state, 'queued')
    store.dispose()
  })
})