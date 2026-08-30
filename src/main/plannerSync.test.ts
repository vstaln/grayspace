import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-planner-sync-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { CoordinationStore } = await import('./coordination.ts')
const { PlannerStore } = await import('./plannerStore.ts')
const { LockManager } = await import('./core/locks.ts')
const { initPlannerSync } = await import('./plannerSync.ts')

after(() => {
  delete process.env.ORCSPACE_TEST_USER_DATA
  fs.rmSync(userData, { recursive: true, force: true })
})

function resetDir(): void {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
}

describe('PlannerSync - Planner & Kanban Board Bidirectional Sync', () => {
  let locks: InstanceType<typeof LockManager>
  let coordination: InstanceType<typeof CoordinationStore>
  let planner: InstanceType<typeof PlannerStore>
  let disposeSync: (() => void) | null = null

  beforeEach(() => {
    resetDir()
    locks = new LockManager()
    coordination = new CoordinationStore(locks)
    planner = new PlannerStore()
  })

  afterEach(() => {
    disposeSync?.()
    disposeSync = null
    planner.dispose()
    coordination.dispose()
  })

  it('hydrates initial planner items into coordination tasks on startup', () => {
    const item1 = planner.createItem({ title: 'Task Alpha', note: 'Brief 1', project: 'Core', createdBy: 'user' })
    const item2 = planner.createItem({ title: 'Task Beta', done: true, createdBy: 'user' })

    disposeSync = initPlannerSync(planner, coordination)

    const tasks = coordination.snapshot().tasks
    assert.equal(tasks.length, 2)

    const task1 = tasks.find((t) => t.id === item1.id)
    assert.ok(task1)
    assert.equal(task1.title, 'Task Alpha')
    assert.equal(task1.brief, 'Brief 1')
    assert.equal(task1.state, 'queued')
    assert.deepEqual(task1.tags, ['Core'])

    const task2 = tasks.find((t) => t.id === item2.id)
    assert.ok(task2)
    assert.equal(task2.title, 'Task Beta')
    assert.equal(task2.state, 'done')
  })

  it('syncs new planner item creation to board tasks', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Build UI', note: 'Component specs', project: 'Frontend', createdBy: 'user' })

    const task = coordination.task(item.id)
    assert.ok(task)
    assert.equal(task.title, 'Build UI')
    assert.equal(task.brief, 'Component specs')
    assert.equal(task.state, 'queued')
    assert.deepEqual(task.tags, ['Frontend'])
  })

  it('syncs planner item update (title, note, project) to board', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Old Title', note: 'Old Note', createdBy: 'user' })
    planner.updateItem(item.id, { title: 'New Title', note: 'New Note', project: 'UpdatedProject' })

    const task = coordination.task(item.id)
    assert.ok(task)
    assert.equal(task.title, 'New Title')
    assert.equal(task.brief, 'New Note')
    assert.deepEqual(task.tags, ['UpdatedProject'])
  })

  it('syncs planner toggle done/undone to board state (Complete <-> To Do)', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Deploy App', createdBy: 'user' })
    assert.equal(coordination.task(item.id)?.state, 'queued')

    // Mark completed in planner
    planner.toggleItem(item.id, true)
    assert.equal(coordination.task(item.id)?.state, 'done')

    // Reopen in planner
    planner.toggleItem(item.id, false)
    assert.equal(coordination.task(item.id)?.state, 'queued')
  })

  it('syncs planner deletion to board task removal', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Temporary task', createdBy: 'user' })
    assert.ok(coordination.task(item.id))

    planner.deleteItem(item.id)
    assert.equal(coordination.task(item.id), undefined)
  })

  it('syncs board task drag to Done into planner completion', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Write tests', createdBy: 'user' })
    assert.equal(planner.get(item.id)?.done, false)

    // Move task to 'done' on board
    coordination.updateTaskAsUser(item.id, { state: 'done' }, { role: 'lead', name: 'user' })

    assert.equal(planner.get(item.id)?.done, true)
  })

  it('syncs board task drag from Done to In Progress into planner reopening', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Refactor engine', done: true, createdBy: 'user' })
    assert.equal(planner.get(item.id)?.done, true)

    // Move task to 'in_progress' on board
    coordination.updateTaskAsUser(item.id, { state: 'in_progress' }, { role: 'lead', name: 'user' })

    assert.equal(planner.get(item.id)?.done, false)
  })

  it('syncs agent claiming a task into in_progress state with assignee', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Optimize queries', createdBy: 'user' })
    
    // Agent 'claude' claims the task
    const claimed = coordination.claimTask(item.id, 'claude')
    assert.equal(claimed.state, 'in_progress')
    assert.equal(claimed.assignee, 'claude')

    // Planner item remains open
    assert.equal(planner.get(item.id)?.done, false)

    // Agent finishes task
    coordination.updateTask(item.id, 'claude', 'done')
    assert.equal(coordination.task(item.id)?.state, 'done')
    assert.equal(planner.get(item.id)?.done, true)
  })

  it('syncs board task deletion to planner item removal', () => {
    disposeSync = initPlannerSync(planner, coordination)

    const item = planner.createItem({ title: 'Will be deleted', createdBy: 'user' })
    assert.ok(planner.get(item.id))

    coordination.deleteTask(item.id)
    assert.equal(planner.get(item.id), undefined)
  })
})
