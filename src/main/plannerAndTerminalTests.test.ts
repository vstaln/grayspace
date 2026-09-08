import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import { join } from 'node:path'
import * as os from 'node:os'
import { after, describe, test, beforeEach, afterEach } from 'node:test'
const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-planner-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData


import { PlannerStore } from './plannerStore.ts'
import { TerminalSnapshots } from './terminalSnapshots.ts'

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})


describe('PlannerStore - public API', () => {
  let savedUserData: string
  let store: PlannerStore

  beforeEach(() => {
    savedUserData = process.env.ORCSPACE_TEST_USER_DATA ?? ''
    const newUserData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-planner-test-'))
    process.env.ORCSPACE_TEST_USER_DATA = newUserData
    store = new PlannerStore()
  })

  afterEach(() => {
    store?.dispose()
    if (savedUserData) {
      process.env.ORCSPACE_TEST_USER_DATA = savedUserData
    } else {
      process.env.ORCSPACE_TEST_USER_DATA = userData
    }
  })

  test('createItem basic creates item with auto order', () => {
    const item = store.createItem({ title: 'My Task', createdBy: 'user' })
    assert.equal(item.title, 'My Task')
    assert.equal(item.done, false)
    assert.equal(item.createdBy, 'user')
    assert.ok(item.id.startsWith('plan-'))
    assert.ok(item.order >= 0)
    assert.equal(item.version, 1)
    assert.equal(item.note, '')
  })

  test('createItem with all fields', () => {
    const item = store.createItem({
      title: 'Project Release',
      note: 'Final release notes',
      project: 'v2.0',
      day: '2026-09-15',
      time: '14:30',
      createdBy: 'user'
    })
    assert.equal(item.title, 'Project Release')
    assert.equal(item.note, 'Final release notes')
    assert.equal(item.project, 'v2.0')
    assert.equal(item.day, '2026-09-15')
    assert.equal(item.time, '14:30')
    assert.equal(item.done, false)
    assert.equal(item.version, 1)
  })

  test('createItem requires title', () => {
    try {
      store.createItem({ createdBy: 'user' })
      assert.fail('should have thrown')
    } catch (err: any) {
      assert.ok(err.message.includes('title is required'))
    }
  })

  test('updateItem modifies fields', () => {
    const item = store.createItem({ title: 'Original', createdBy: 'user' })
    const updated = store.updateItem(item.id, {
      title: 'Updated',
      note: 'New notes',
      done: true
    })
    assert.equal(updated.title, 'Updated')
    assert.equal(updated.note, 'New notes')
    assert.equal(updated.done, true)
    assert.equal(updated.version, 2)
  })

  test('updateItem toggles done flag', () => {
    const item = store.createItem({ title: 'Toggle me', createdBy: 'user' })
    let toggled = store.toggleItem(item.id)
    assert.equal(toggled.done, true)
    toggled = store.toggleItem(item.id)
    assert.equal(toggled.done, false)
  })

  test('deleteItem removes item', () => {
    const item = store.createItem({ title: 'To Delete', createdBy: 'user' })
    store.deleteItem(item.id)
    assert.equal(store.get(item.id), undefined)
  })

  test('list sorts by day then order', () => {
    store.createItem({ title: 'Mon Morning', day: '2026-01-01', createdBy: 'user' })
    store.createItem({ title: 'Fri Afternoon', day: '2026-01-05', createdBy: 'user' })
    store.createItem({ title: 'Tue Lunch', day: '2026-01-02', createdBy: 'user' })

    const items = store.list()
    assert.equal(items[0].title, 'Mon Morning')
    assert.equal(items[1].title, 'Tue Lunch')
    assert.equal(items[2].title, 'Fri Afternoon')
  })

  test('list items without day come after day items', () => {
    store.createItem({ title: 'No Day 1', createdBy: 'user' })
    store.createItem({ title: 'With Day', day: '2026-01-01', createdBy: 'user' })

    const items = store.list()

    assert.ok(items[0].day === '2026-01-01', 'day items should come first')
  })

  test('toggleItem flips done flag', () => {
    const item = store.createItem({ title: 'Toggle me', createdBy: 'user' })
    let toggled = store.toggleItem(item.id)
    assert.equal(toggled.done, true)
    toggled = store.toggleItem(item.id)
    assert.equal(toggled.done, false)
  })
})


describe('TerminalSnapshots - public API', () => {
  let savedUserData: string
  let snapshots: TerminalSnapshots

  beforeEach(() => {
    savedUserData = process.env.ORCSPACE_TEST_USER_DATA ?? ''
    const newUserData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-term-test-'))
    process.env.ORCSPACE_TEST_USER_DATA = newUserData
    snapshots = new TerminalSnapshots()
  })

  afterEach(() => {
    if (savedUserData) {
      process.env.ORCSPACE_TEST_USER_DATA = savedUserData
    } else {
      process.env.ORCSPACE_TEST_USER_DATA = userData
    }
  })

  test('save and retrieve scrollback', () => {
    const longText = 'Build log line 1\nBuild log line 2\n'.repeat(100)
    snapshots.save({ id: 'term-1', title: 'Build Terminal', cwd: '/home/user', scrollback: longText })
    const retrieved = snapshots.scrollback('term-1')
    assert.ok(retrieved.length > 0, 'should have scrollback text')
    assert.ok(retrieved.startsWith('Build log line 1'))
  })

  test('Code and Canvas scrollback keep ANSI colours for replay', () => {
    for (const id of ['code-1', 'term-1']) {
      snapshots.save({
        id,
        title: id.startsWith('code-') ? 'Code' : 'Canvas',
        cwd: '/',
        scrollback: '\x1b[31mred\x1b[0m plain\x1b]52;c;secret\x07\n'
      })
      assert.equal(snapshots.scrollback(id), '\x1b[31mred\x1b[0m plain\n')
    }
  })

  test('scrollback returns empty for non-existent terminal', () => {
    const result = snapshots.scrollback('nonexistent')
    assert.equal(result, '')
  })

  test('save truncates scrollback to MAX_SCROLLBACK_BYTES', () => {
    const largeText = 'x'.repeat(200 * 1024)
    snapshots.save({ id: 'term-big', title: 'Big Terminal', cwd: '/', scrollback: largeText })
    const sb = snapshots.scrollback('term-big')

    assert.ok(Buffer.byteLength(sb) <= 64 * 1024, 'scrollback should be bounded')

    assert.ok(sb.startsWith('x'), 'should keep end of text')
  })

  test('the byte budget holds for non-ASCII output, not just ASCII', () => {


    const russian = 'Сборка завершена успешно\n'.repeat(8_000)
    snapshots.save({ id: 'term-ru', title: 'RU', cwd: '/', scrollback: russian })
    const sb = snapshots.scrollback('term-ru')
    assert.ok(Buffer.byteLength(russian) > 64 * 1024, 'fixture is bigger than the budget')
    assert.ok(Buffer.byteLength(sb) <= 64 * 1024, `kept ${Buffer.byteLength(sb)} bytes`)
    assert.ok(sb.endsWith('\n'), 'the tail still ends on a line boundary')
    assert.ok(!sb.includes('�'), 'no character was cut in half')
  })

  test('forget removes terminal and its scrollback file', () => {
    snapshots.save({ id: 'term-to-go', title: 'Gone', cwd: '/', scrollback: 'some text' })
    assert.ok(snapshots.get('term-to-go'), 'item exists before forget')
    snapshots.forget('term-to-go')
    assert.ok(!snapshots.get('term-to-go'), 'item should be gone after forget')
  })

  test('prune removes terminals not in liveIds', () => {
    snapshots.save({ id: 'term-alive', title: 'Alive', cwd: '/', scrollback: 'alive text' })
    snapshots.save({ id: 'term-dead', title: 'Dead', cwd: '/', scrollback: 'dead text' })
    snapshots.prune(['term-alive'])
    assert.ok(snapshots.get('term-alive'), 'kept terminal still exists')
    assert.ok(!snapshots.get('term-dead'), 'removed terminal gone')
  })

  test('list returns all stored snapshots', () => {
    snapshots.save({ id: 't1', title: 'One', cwd: '/a', scrollback: 'a' })
    snapshots.save({ id: 't2', title: 'Two', cwd: '/b', scrollback: 'b' })
    const all = snapshots.list()
    assert.equal(all.length, 2)
  })
})
