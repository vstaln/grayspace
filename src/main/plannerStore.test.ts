import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-planner-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { PlannerStore, PLANNER_SCHEMA_VERSION } = await import('./plannerStore.ts')

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})

function reset(): void {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
}

describe('PlannerStore', () => {
  beforeEach(() => {
    reset()
  })

  test('createItem generates ids, orders items, and bumps versions', () => {
    const store = new PlannerStore()
    const item1 = store.createItem({ title: 'Task 1', day: '2026-08-15', createdBy: 'user' })
    assert.equal(item1.title, 'Task 1')
    assert.equal(item1.day, '2026-08-15')
    assert.equal(item1.done, false)
    assert.equal(item1.order, 0)
    assert.equal(item1.version, 1)

    const item2 = store.createItem({ title: 'Task 2', day: '2026-08-15', createdBy: 'agent' })
    assert.equal(item2.order, 1)
    assert.equal(item2.version, 1)

    const list = store.list()
    assert.equal(list.length, 2)
    store.dispose()
  })

  test('updateItem modifies fields and bumps optimistic version', () => {
    const store = new PlannerStore()
    const item = store.createItem({ title: 'Original', createdBy: 'user' })
    assert.equal(item.version, 1)

    const updated = store.updateItem(item.id, { title: 'Updated Title', note: 'detailed notes', done: true })
    assert.equal(updated.title, 'Updated Title')
    assert.equal(updated.note, 'detailed notes')
    assert.equal(updated.done, true)
    assert.equal(updated.version, 2)
    store.dispose()
  })

  test('toggleItem flips status and bumps version', () => {
    const store = new PlannerStore()
    const item = store.createItem({ title: 'Toggle Me', createdBy: 'user' })
    assert.equal(item.done, false)
    assert.equal(item.version, 1)

    const toggled1 = store.toggleItem(item.id)
    assert.equal(toggled1.done, true)
    assert.equal(toggled1.version, 2)

    const toggled2 = store.toggleItem(item.id, false)
    assert.equal(toggled2.done, false)
    assert.equal(toggled2.version, 3)

    const toggled3 = store.toggleItem(item.id, true)
    assert.equal(toggled3.done, true)
    assert.equal(toggled3.version, 4)
    store.dispose()
  })

  test('deleteItem removes item and cleans up versions', () => {
    const store = new PlannerStore()
    const item = store.createItem({ title: 'To Delete', createdBy: 'user' })
    assert.equal(store.list().length, 1)

    store.deleteItem(item.id)
    assert.equal(store.list().length, 0)
    assert.equal(store.get(item.id), undefined)
    assert.equal(store.versions.current(item.id), 0)
    store.dispose()
  })

  test('accepts today/tomorrow and rejects garbage day strings', () => {
    const store = new PlannerStore()
    const today = store.createItem({ title: 'Today item', day: 'today', createdBy: 'user' })
    assert.match(today.day ?? '', /^\d{4}-\d{2}-\d{2}$/)
    const loose = store.createItem({ title: 'Loose', day: '2026-8-16', createdBy: 'user' })
    assert.equal(loose.day, '2026-08-16')
    assert.throws(() => store.createItem({ title: 'Bad', day: 'Monday', createdBy: 'user' }))
    store.dispose()
  })

  test('persists to disk and reloads on startup', () => {
    const store1 = new PlannerStore()
    store1.createItem({ title: 'Persistent Item', day: '2026-08-16', note: 'Remember this', createdBy: 'user' })
    store1.dispose()

    const store2 = new PlannerStore()
    const list = store2.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].title, 'Persistent Item')
    assert.equal(list[0].day, '2026-08-16')
    assert.equal(list[0].note, 'Remember this')
    assert.equal(list[0].version, 1)
    store2.dispose()
  })
})
