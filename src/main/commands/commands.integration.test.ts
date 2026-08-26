import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { describe, it, beforeEach, afterEach } from 'node:test'

const testDir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-cmd-integration-'))
process.env.ORCSPACE_TEST_USER_DATA = testDir

import { createCore, CommandError, type Core, type Actor } from '../core/index.ts'
import { BrainStore } from '../brain.ts'
import { CanvasStore } from '../canvasState.ts'
import { CoordinationStore } from '../coordination.ts'
import { PlannerStore } from '../plannerStore.ts'
import { TerminalManager } from '../terminals.ts'
import { TerminalSnapshots } from '../terminalSnapshots.ts'
import { registerCommands, NEW } from './index.ts'

describe('Commands Integration — End-to-End Bus Execution', () => {
  let core: Core
  let brain: BrainStore
  let canvas: CanvasStore
  let board: CoordinationStore
  let planner: PlannerStore
  let terminals: TerminalManager
  let snapshots: TerminalSnapshots
  let user: Actor
  let agent: Actor

  beforeEach(() => {
    core = createCore()
    user = core.actors.register({ id: 'user', type: 'user', transport: 'ipc' })
    agent = core.actors.register({ id: 'agent-alpha', type: 'agent', transport: 'mcp' })

    brain = new BrainStore(() => 'wiki')
    canvas = new CanvasStore()
    board = new CoordinationStore(core.locks, (id) => core.actors.isAlive(id))
    planner = new PlannerStore()
    terminals = new TerminalManager()
    snapshots = new TerminalSnapshots()

    registerCommands({
      core,
      canvas,
      brain,
      board,
      planner,
      terminals,
      snapshots,
      requestWidget: () => {},
      requestWidgetRemoval: () => {},
      originWidgetId: () => null,
      forgetOrigin: () => {},
      defaultCwd: () => testDir
    })
  })

  afterEach(() => {
    planner.dispose()
    brain.dispose()
    canvas.dispose()
    board.dispose()
    core.dispose()
  })

  it('executes full note lifecycle: create -> update -> delete -> restore -> purge', async () => {
    // 1. Create note
    const createRes = await core.bus.submit<any>({
      id: 'cmd-note-1',
      actorId: user.id,
      type: 'note.create',
      target: NEW.note,
      payload: { title: 'Integration Note', content: 'Initial body [[Link]]' }
    })

    assert.strictEqual(createRes.ok, true)
    const note = createRes.data
    assert.ok(note.id.startsWith('note-') || note.id.length > 0)
    assert.strictEqual(note.title, 'Integration Note')

    // 2. Update note
    const updateRes = await core.bus.submit<any>({
      id: 'cmd-note-2',
      actorId: user.id,
      type: 'note.update',
      target: `note:${note.id}`,
      payload: { title: 'Updated Title', content: 'Updated content' }
    })

    assert.strictEqual(updateRes.ok, true)
    assert.strictEqual(updateRes.data.title, 'Updated Title')

    // 3. Delete (soft delete) note
    const deleteRes = await core.bus.submit<any>({
      id: 'cmd-note-3',
      actorId: user.id,
      type: 'note.delete',
      target: `note:${note.id}`,
      payload: {}
    })
    assert.strictEqual(deleteRes.ok, true)
    assert.strictEqual(deleteRes.data.id, note.id)

    // 4. Restore note
    const restoreRes = await core.bus.submit<any>({
      id: 'cmd-note-4',
      actorId: user.id,
      type: 'note.restore',
      target: `note:${note.id}`,
      payload: {}
    })
    assert.strictEqual(restoreRes.ok, true)
    assert.strictEqual(restoreRes.data.title, 'Updated Title')

    // 5. Purge note
    const purgeRes = await core.bus.submit({
      id: 'cmd-note-5',
      actorId: user.id,
      type: 'note.purge',
      target: `note:${note.id}`,
      payload: {}
    })
    assert.strictEqual(purgeRes.ok, true)
  })

  it('executes full task lifecycle: create -> claim -> update -> delete', async () => {
    // 1. Create task
    const createRes = await core.bus.submit<any>({
      id: 'cmd-task-1',
      actorId: user.id,
      type: 'task.create',
      target: NEW.task,
      payload: { title: 'Backend task', brief: 'Fix something' }
    })

    assert.strictEqual(createRes.ok, true)
    const task = createRes.data
    assert.strictEqual(task.title, 'Backend task')
    assert.strictEqual(task.state, 'queued')

    // 2. Agent claims task
    const claimRes = await core.bus.submit<any>({
      id: 'cmd-task-2',
      actorId: agent.id,
      type: 'task.claim',
      target: `task:${task.id}`,
      payload: {}
    })

    assert.strictEqual(claimRes.ok, true)
    assert.strictEqual(claimRes.data.assignee, 'agent-alpha')
    assert.strictEqual(claimRes.data.state, 'in_progress')

    // 3. Agent completes task
    const updateRes = await core.bus.submit<any>({
      id: 'cmd-task-3',
      actorId: agent.id,
      type: 'task.update',
      target: `task:${task.id}`,
      payload: { state: 'done' }
    })

    assert.strictEqual(updateRes.ok, true)
    assert.strictEqual(updateRes.data.state, 'done')

    // 4. User deletes task
    const deleteRes = await core.bus.submit<any>({
      id: 'cmd-task-4',
      actorId: user.id,
      type: 'task.delete',
      target: `task:${task.id}`,
      payload: {}
    })

    assert.strictEqual(deleteRes.ok, true)
  })

  it('executes planner commands: create -> update -> toggle -> delete', async () => {
    // 1. Create planner item
    const createRes = await core.bus.submit<any>({
      id: 'cmd-plan-1',
      actorId: user.id,
      type: 'plan.create',
      target: NEW.plan,
      payload: { title: 'Write tests', project: 'OrcSpace', day: '2026-08-16' }
    })

    assert.strictEqual(createRes.ok, true)
    const item = createRes.data
    assert.strictEqual(item.title, 'Write tests')
    assert.strictEqual(item.done, false)

    // 2. Toggle item
    const toggleRes = await core.bus.submit<any>({
      id: 'cmd-plan-2',
      actorId: user.id,
      type: 'plan.toggle',
      target: `plan:${item.id}`,
      payload: { done: true }
    })

    assert.strictEqual(toggleRes.ok, true)
    assert.strictEqual(toggleRes.data.done, true)

    // 3. Update item
    const updateRes = await core.bus.submit<any>({
      id: 'cmd-plan-3',
      actorId: user.id,
      type: 'plan.update',
      target: `plan:${item.id}`,
      payload: { note: 'Finished in 10ms' }
    })

    assert.strictEqual(updateRes.ok, true)
    assert.strictEqual(updateRes.data.note, 'Finished in 10ms')

    // 4. Delete item
    const deleteRes = await core.bus.submit<any>({
      id: 'cmd-plan-4',
      actorId: user.id,
      type: 'plan.delete',
      target: `plan:${item.id}`,
      payload: {}
    })

    assert.strictEqual(deleteRes.ok, true)
  })

  it('executes canvas widget lifecycle and camera panning', async () => {
    // 1. Create widget
    const createRes = await core.bus.submit<any>({
      id: 'cmd-w-1',
      actorId: user.id,
      type: 'widget.create',
      target: NEW.widget,
      payload: { kind: 'note', title: 'My Note Widget', x: 100, y: 200, w: 400, h: 300 }
    })

    assert.strictEqual(createRes.ok, true)
    const widget = createRes.data
    assert.strictEqual(widget.x, 100)
    assert.strictEqual(widget.y, 200)

    // 2. Update widget position
    const updateRes = await core.bus.submit<any>({
      id: 'cmd-w-2',
      actorId: user.id,
      type: 'widget.update',
      target: `widget:${widget.id}`,
      payload: { x: 150, y: 250 }
    })

    assert.strictEqual(updateRes.ok, true)
    assert.strictEqual(updateRes.data.x, 150)
    assert.strictEqual(updateRes.data.y, 250)

    // 3. Pan camera
    const cameraRes = await core.bus.submit<any>({
      id: 'cmd-cam-1',
      actorId: user.id,
      type: 'canvas.camera',
      target: 'canvas:current',
      payload: { x: 50, y: 50, zoom: 1.5 }
    })

    assert.strictEqual(cameraRes.ok, true)

    // 4. Remove widget
    const removeRes = await core.bus.submit({
      id: 'cmd-w-3',
      actorId: user.id,
      type: 'widget.remove',
      target: `widget:${widget.id}`,
      payload: {}
    })

    assert.strictEqual(removeRes.ok, true)
  })

  it('rejects commands with malformed targets', async () => {
    const res = await core.bus.submit({
      id: 'cmd-err-1',
      actorId: user.id,
      type: 'note.update',
      target: 'invalid-target',
      payload: {}
    })

    assert.strictEqual(res.ok, false)
    if (!res.ok) {
      assert.strictEqual(res.code, 'invalid')
    }
  })
})
