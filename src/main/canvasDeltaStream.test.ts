import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { CanvasDeltaStream } from './canvasDelta.ts'
import type { CanvasSnapshot } from './canvasState.ts'
import { Journal } from './core/journal.ts'

function makeSnapshot(): CanvasSnapshot {
  return {
    snapshotSeq: 0,
    schemaVersion: 3,
    widgets: [{
      id: 'w1',
      title: 'Terminal',
      kind: 'terminal',
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      z: 1,
      version: 1,
      updatedAt: 1
    }],
    camera: { x: 0, y: 0, zoom: 1 },
    strokes: [],
    connections: [],
    version: 1
  }
}

describe('CanvasDeltaStream', () => {
  test('emits committed widget deltas and ignores non-canvas entries', () => {
    const journal = new Journal({ now: () => 1 })
    let state = makeSnapshot()
    const stream = new CanvasDeltaStream({ journal, snapshot: () => state, maxEvents: 10 })
    const deltas: Array<Awaited<ReturnType<CanvasDeltaStream['replay']>>['events'][number]> = []
    stream.on('delta', (delta) => deltas.push(delta))

    journal.append({ phase: 'commit', actorId: 'agent-a', type: 'planner.update', target: 'plan:p1' })
    state = { ...state, widgets: [{ ...state.widgets[0], x: 20, y: 30, version: 2 }], version: 2 }
    const entry = journal.append({
      phase: 'commit',
      actorId: 'agent-a',
      type: 'widget.update',
      target: 'widget:w1',
      payload: { x: 20, y: 30 },
      commandId: 'cmd-drag-1',
      version: 2
    })

    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].seq, entry.seq)
    assert.equal(deltas[0].actorId, 'agent-a')
    assert.equal(deltas[0].commandId, 'cmd-drag-1')
    assert.equal(deltas[0].resourceId, 'widget:w1')
    assert.deepEqual(deltas[0].patch, { op: 'update', id: 'w1', changes: { x: 20, y: 30 } })

    const replay = stream.replay(0)
    assert.equal(replay.resetRequired, false)
    assert.deepEqual(replay.events, deltas)
    stream.dispose()
  })

  test('requests a snapshot when the delta ring has truncated history', () => {
    const journal = new Journal()
    let state = makeSnapshot()
    const stream = new CanvasDeltaStream({ journal, snapshot: () => state, maxEvents: 2 })

    for (let index = 0; index < 3; index += 1) {
      state = { ...state, widgets: [{ ...state.widgets[0], x: index, version: index + 2 }], version: index + 2 }
      journal.append({
        phase: 'commit',
        actorId: 'agent-a',
        type: 'widget.update',
        target: 'widget:w1',
        payload: { x: index },
        version: index + 2
      })
    }

    const replay = stream.replay(0)
    assert.equal(replay.resetRequired, true)
    assert.equal(replay.events.length, 2)
    assert.deepEqual(replay.snapshot, state)
    stream.dispose()
  })

  test('requests a snapshot after a workspace switch and emits transaction replacements', () => {
    const journal = new Journal()
    let workspace: string | undefined = 'workspace-a'
    let state = makeSnapshot()
    const stream = new CanvasDeltaStream({ journal, snapshot: () => state, workspaceDir: () => workspace })
    const deltas: any[] = []
    stream.on('delta', (delta) => deltas.push(delta))

    journal.append({
      phase: 'commit',
      actorId: 'agent-a',
      type: 'flow.transact',
      target: 'system:transaction',
      payload: { commands: [{ target: 'widget:w1', type: 'widget.update' }] }
    })
    assert.equal(deltas[0].patch.op, 'replace')
    assert.equal(deltas[0].resourceId, 'canvas:main')

    workspace = 'workspace-b'
    const replay = stream.replay(0)
    assert.equal(replay.resetRequired, true)
    assert.equal(replay.workspaceDir, 'workspace-b')
    assert.deepEqual(replay.snapshot, state)
    stream.dispose()
  })
})
