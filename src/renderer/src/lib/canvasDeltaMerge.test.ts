import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shouldApplyUpsert, applyDeltaToWidgets } from './canvasDeltaMerge.ts'
import type { CanvasWidget, CanvasDelta } from '../../../preload/api'

function makeWidget(id: string, version = 1, x = 0, y = 0): CanvasWidget {
  return {
    id,
    kind: 'terminal',
    x,
    y,
    w: 500,
    h: 300,
    z: 1,
    title: `term-${id}`,
    version
  }
}

function makeDelta(
  seq: number,
  patch: CanvasDelta['patch'],
  workspaceDir: string | null = null
): CanvasDelta {
  return {
    schemaVersion: 1,
    eventId: `evt-${seq}`,
    seq,
    workspaceDir,
    resourceId: 'canvas',
    version: 1,
    actorId: 'test-agent',
    type: 'canvas.widget.patch',
    patch
  }
}

describe('canvasDeltaMerge - shouldApplyUpsert', () => {
  test('allows upsert when no local widget exists', () => {
    const incoming = makeWidget('w1', 2)
    assert.equal(shouldApplyUpsert(undefined, incoming), true)
  })

  test('rejects upsert when incoming version is older or equal', () => {
    const local = makeWidget('w1', 2)
    const incomingOlder = makeWidget('w1', 1)
    const incomingEqual = makeWidget('w1', 2)
    assert.equal(shouldApplyUpsert(local, incomingOlder), false)
    assert.equal(shouldApplyUpsert(local, incomingEqual), false)
  })

  test('allows upsert when incoming version is newer', () => {
    const local = makeWidget('w1', 2)
    const incomingNewer = makeWidget('w1', 3)
    assert.equal(shouldApplyUpsert(local, incomingNewer), true)
  })

  test('rejects upsert when widget is suppressed during active drag', () => {
    const local = makeWidget('w1', 1)
    const incoming = makeWidget('w1', 2)
    const context = { suppressedWidgetIds: new Set(['w1']) }
    assert.equal(shouldApplyUpsert(local, incoming, context), false)
  })

  test('rejects upsert when unversioned local widget has dirty edits', () => {
    const local = { ...makeWidget('w1'), version: undefined }
    const incoming = makeWidget('w1', 2)
    const context = { dirtyWidgetIds: new Set(['w1']) }
    assert.equal(shouldApplyUpsert(local, incoming, context), false)
  })
})

describe('canvasDeltaMerge - applyDeltaToWidgets', () => {
  test('adds new widget on upsert', () => {
    const prev: CanvasWidget[] = [makeWidget('w1', 1)]
    const newWidget = makeWidget('w2', 1, 100, 100)
    const delta = makeDelta(1, { op: 'upsert', widget: newWidget })

    const result = applyDeltaToWidgets(prev, delta)
    assert.equal(result.length, 2)
    assert.equal(result[1].id, 'w2')
    assert.equal(result[1].x, 100)
  })

  test('updates existing widget when version is newer', () => {
    const prev: CanvasWidget[] = [makeWidget('w1', 1, 0, 0)]
    const updated = makeWidget('w1', 2, 250, 300)
    const delta = makeDelta(2, { op: 'upsert', widget: updated })

    const result = applyDeltaToWidgets(prev, delta)
    assert.equal(result.length, 1)
    assert.equal(result[0].x, 250)
    assert.equal(result[0].y, 300)
    assert.equal(result[0].version, 2)
  })

  test('ignores upsert if widget is in pendingDeletes', () => {
    const prev: CanvasWidget[] = []
    const incoming = makeWidget('w1', 1)
    const delta = makeDelta(3, { op: 'upsert', widget: incoming })
    const context = { pendingDeletes: new Set(['w1']) }

    const result = applyDeltaToWidgets(prev, delta, context)
    assert.equal(result.length, 0)
  })

  test('removes widget on remove op', () => {
    const prev: CanvasWidget[] = [makeWidget('w1', 1), makeWidget('w2', 1)]
    const delta = makeDelta(4, { op: 'remove', id: 'w1' })

    const result = applyDeltaToWidgets(prev, delta)
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'w2')
  })

  test('applies partial changes on update op', () => {
    const prev: CanvasWidget[] = [makeWidget('w1', 1, 0, 0)]
    const delta = {
      ...makeDelta(5, { op: 'update', id: 'w1', changes: { x: 50, title: 'new-title' } }),
      version: 2
    }

    const result = applyDeltaToWidgets(prev, delta)
    assert.equal(result.length, 1)
    assert.equal(result[0].x, 50)
    assert.equal(result[0].y, 0)
    assert.equal(result[0].title, 'new-title')
    assert.equal(result[0].version, 2)
  })

  test('returns identical reference if remove target is absent', () => {
    const prev: CanvasWidget[] = [makeWidget('w1', 1)]
    const delta = makeDelta(5, { op: 'remove', id: 'w99' })

    const result = applyDeltaToWidgets(prev, delta)
    assert.equal(result, prev)
  })

  test('handles replace op containing snapshot widgets', () => {
    const prev: CanvasWidget[] = [makeWidget('w1', 1)]
    const replacedList = [makeWidget('w10', 1), makeWidget('w11', 1)]
    const delta = makeDelta(6, { op: 'replace', value: { widgets: replacedList } as any })

    const result = applyDeltaToWidgets(prev, delta)
    assert.deepEqual(result, replacedList)
  })
})
