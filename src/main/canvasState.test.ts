import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { CanvasStore, sanitizeStrokesJs, sanitizeWidget, type CanvasDataState, type CanvasWidget } from './canvasState.ts'
import type { JournalEntry } from './core/index.ts'

const point = (x: number, y: number) => ({ x, y })








describe('canvas stroke sanitizer edge cases', () => {
  test('valid strokes survive with points in order', () => {
    const out = sanitizeStrokesJs([{ id: 'a', color: '#fff', points: [point(1, 2), point(3, 4)] }])
    assert.deepStrictEqual(out, [{ id: 'a', points: [point(1, 2), point(3, 4)], color: '#fff' }])
  })

  test('an empty array stays empty', () => {
    assert.deepStrictEqual(sanitizeStrokesJs([]), [])
  })

  test('a non-array input yields no strokes', () => {
    assert.deepStrictEqual(sanitizeStrokesJs({ id: 'not-a-stroke' }), [])
  })

  test('an empty colour string is still a colour', () => {
    const out = sanitizeStrokesJs([{ id: 'a', color: '', points: [point(0, 0), point(-0, 1)] }])
    assert.equal(out.length, 1)
    assert.equal(out[0].color, '')

    assert.ok(Object.is(out[0].points[1].x, 0))
  })

  test('a single-point stroke is discarded', () => {
    assert.deepStrictEqual(sanitizeStrokesJs([{ id: 'a', color: '#fff', points: [point(1, 2)] }]), [])
  })

  test('a stroke is capped at 10,000 points', () => {
    const out = sanitizeStrokesJs([
      { id: 'a', color: '#fff', points: Array.from({ length: 10_001 }, (_, i) => point(i, i)) }
    ])
    assert.equal(out[0].points.length, 10_000)
  })

  test('the canvas is capped at 200,000 points across strokes', () => {
    const out = sanitizeStrokesJs(
      Array.from({ length: 21 }, (_, stroke) => ({
        id: String(stroke),
        color: '#000',
        points: Array.from({ length: 10_000 }, (_, i) => point(i, stroke))
      }))
    )
    assert.equal(out.length, 20)
    assert.equal(out.reduce((n, s) => n + s.points.length, 0), 200_000)
  })
})






describe('sanitizeStrokesJs', () => {
  test('keeps a well-formed stroke intact', () => {
    const result = sanitizeStrokesJs([{ id: 'a', color: '#fff', points: [point(1, 2), point(3, 4)] }])
    assert.deepStrictEqual(result, [{ id: 'a', points: [point(1, 2), point(3, 4)], color: '#fff' }])
  })

  test('drops malformed points but keeps the stroke around them', () => {
    const result = sanitizeStrokesJs([
      { id: 'a', color: '#fff', points: [null, point(1, 2), { x: 'bad', y: 4 }, point(3, 4)] }
    ])
    assert.deepStrictEqual(result[0].points, [point(1, 2), point(3, 4)])
  })

  test('rejects anything that is not an array of strokes', () => {
    assert.deepStrictEqual(sanitizeStrokesJs({ id: 'not-a-stroke' }), [])
    assert.deepStrictEqual(sanitizeStrokesJs(null), [])
    assert.deepStrictEqual(sanitizeStrokesJs(undefined), [])
    assert.deepStrictEqual(sanitizeStrokesJs('[]'), [])
    assert.deepStrictEqual(sanitizeStrokesJs([]), [])
  })

  test('discards strokes missing the fields a stroke is made of', () => {
    assert.deepStrictEqual(
      sanitizeStrokesJs([
        null,
        { color: '#fff', points: [point(0, 0), point(1, 1)] },
        { id: 'a', points: [point(0, 0), point(1, 1)] },
        { id: 'a', color: '#fff', points: 'nope' }
      ]),
      []
    )
  })

  test('a stroke of fewer than two points is not a line, so it goes', () => {
    assert.deepStrictEqual(sanitizeStrokesJs([{ id: 'a', color: '#fff', points: [point(1, 2)] }]), [])
    assert.deepStrictEqual(sanitizeStrokesJs([{ id: 'a', color: '#fff', points: [] }]), [])
  })

  test('NaN and Infinity are not coordinates', () => {
    const result = sanitizeStrokesJs([
      { id: 'a', color: '#fff', points: [point(NaN, 1), point(1, Infinity), point(2, 2), point(3, 3)] }
    ])
    assert.deepStrictEqual(result[0].points, [point(2, 2), point(3, 3)])
  })

  test('caps one stroke at 10k points instead of trusting the file', () => {
    const result = sanitizeStrokesJs([
      { id: 'a', color: '#fff', points: Array.from({ length: 10_001 }, (_, i) => point(i, i)) }
    ])
    assert.equal(result[0].points.length, 10_000)
  })

  test('stops once the whole canvas hits the total point budget', () => {
    const result = sanitizeStrokesJs(
      Array.from({ length: 21 }, (_, stroke) => ({
        id: String(stroke),
        color: '#000',
        points: Array.from({ length: 10_000 }, (_, i) => point(i, stroke))
      }))
    )
    assert.equal(result.length, 20, '21st stroke is past the budget')
    assert.equal(result.reduce((sum, s) => sum + s.points.length, 0), 200_000)
  })

  test('an empty colour string is a colour, not a reason to drop the stroke', () => {
    const result = sanitizeStrokesJs([{ id: 'a', color: '', points: [point(0, 0), point(-0, 1)] }])
    assert.equal(result.length, 1)
    assert.equal(result[0].color, '')
  })
})







describe('CanvasStore.reduce purity', () => {
  const widget = (id: string): CanvasWidget => ({
    id,
    title: id,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: 1,
    maximized: false,
    version: 1,
    updatedAt: 1
  })

  const baseState = (): CanvasDataState => ({
    widgets: new Map([['a', widget('a')]]),
    camera: { x: 0, y: 0, zoom: 1 },
    strokes: [{ id: 's', color: '#fff', points: [point(0, 0), point(1, 1)] }],
    connections: [],
    version: 1
  })

  const event = (type: string, target: string, payload: unknown = {}): JournalEntry =>
    ({ seq: 1, at: 1, phase: 'commit', type, target, payload, version: 2 }) as unknown as JournalEntry

  test('an event that touches no widget hands the same map back', () => {
    const state = baseState()
    const next = CanvasStore.reduce(state, event('canvas.camera', 'canvas:main', { x: 5, y: 6, zoom: 2 }))
    assert.equal(next.widgets, state.widgets, 'no widget changed, so no clone is warranted')
    assert.deepStrictEqual(next.camera, { x: 5, y: 6, zoom: 2 })
    assert.equal(next.strokes, state.strokes)
  })

  test('a widget write clones rather than mutating the input map', () => {
    const state = baseState()
    const next = CanvasStore.reduce(state, event('widget.update', 'widget:a', { title: 'renamed' }))
    assert.notEqual(next.widgets, state.widgets)
    assert.equal(state.widgets.get('a')?.title, 'a', 'the input state must be untouched')
    assert.equal(next.widgets.get('a')?.title, 'renamed')
  })

  test('removing a widget that is not there does not clone either', () => {
    const state = baseState()
    const next = CanvasStore.reduce(state, event('widget.remove', 'widget:missing'))
    assert.equal(next.widgets, state.widgets)
  })

  test('removing a widget that is there leaves the input intact', () => {
    const state = baseState()
    const next = CanvasStore.reduce(state, event('widget.remove', 'widget:a'))
    assert.equal(next.widgets.size, 0)
    assert.equal(state.widgets.size, 1)
  })

  test('a non-commit event is a no-op', () => {
    const state = baseState()
    const pending = { ...event('widget.remove', 'widget:a'), phase: 'pending' } as unknown as JournalEntry
    assert.equal(CanvasStore.reduce(state, pending), state)
  })

  const linked = (): CanvasDataState => ({
    ...baseState(),
    widgets: new Map([['a', widget('a')], ['b', widget('b')]]),
    connections: [{ id: 'c1', from: 'a', to: 'b', bornAt: 1 }]
  })

  test('removing a widget takes its arcs with it', () => {
    const state = linked()
    const next = CanvasStore.reduce(state, event('widget.remove', 'widget:b'))
    assert.deepStrictEqual(next.connections, [], 'an arc to a widget that is gone has nothing to draw between')
    assert.equal(state.connections.length, 1, 'the input state must be untouched')
  })

  test('an arc naming a widget that does not exist is refused', () => {
    const state = linked()
    const next = CanvasStore.reduce(
      state,
      event('canvas.connections', 'canvas:main', {
        connections: [
          { id: 'c1', from: 'a', to: 'b', bornAt: 1 },
          { id: 'c2', from: 'a', to: 'ghost', bornAt: 1 }
        ]
      })
    )
    assert.deepStrictEqual(next.connections.map((c) => c.id), ['c1'])
  })

  test('the same pair twice collapses to one arc', () => {
    const state = linked()
    const next = CanvasStore.reduce(
      state,
      event('canvas.connections', 'canvas:main', {
        connections: [
          { id: 'c1', from: 'a', to: 'b', bornAt: 1 },
          { id: 'c2', from: 'a', to: 'b', bornAt: 2 }
        ]
      })
    )
    assert.equal(next.connections.length, 1)
  })

  test('an arc from a widget to itself is refused', () => {
    const state = linked()
    const next = CanvasStore.reduce(
      state,
      event('canvas.connections', 'canvas:main', {
        connections: [{ id: 'c1', from: 'a', to: 'a', bornAt: 1 }]
      })
    )
    assert.deepStrictEqual(next.connections, [])
  })
})

describe('Image widget persistence', () => {
  test('keeps durable media references while rejecting oversized metadata', () => {
    const image = sanitizeWidget({
      id: 'image-1',
      title: 'Screenshot',
      kind: 'image',
      imagePath: 'C:/Users/test/AppData/Roaming/OrcSpace/media/a.png',
      imageName: 'a.png',
      x: 0,
      y: 0,
      w: 560,
      h: 420,
      z: 1
    })
    assert.equal(image?.kind, 'image')
    assert.equal(image?.imagePath, 'C:/Users/test/AppData/Roaming/OrcSpace/media/a.png')
    assert.equal(image?.imageName, 'a.png')

    const oversized = sanitizeWidget({
      id: 'image-2', title: 'Bad', kind: 'image', imagePath: 'x'.repeat(4097),
      x: 0, y: 0, w: 560, h: 420, z: 1
    })
    assert.ok(oversized, 'metadata should not invalidate the widget itself')
    assert.equal(oversized?.imagePath, undefined)
  })
})
