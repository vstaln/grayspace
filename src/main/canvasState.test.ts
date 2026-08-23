import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { sanitizeStrokesJs, sanitizeStrokesNative } from './canvasState.ts'

const point = (x: number, y: number) => ({ x, y })

const fixtures: Array<[string, unknown]> = [
  ['valid strokes', [{ id: 'a', color: '#fff', points: [point(1, 2), point(3, 4)] }]],
  ['invalid points', [{ id: 'a', color: '#fff', points: [null, point(1, 2), { x: 'bad', y: 4 }, point(3, 4)] }]],
  ['empty array', []],
  ['non-array', { id: 'not-a-stroke' }],
  ['minimum boundary', [{ id: 'a', color: '', points: [point(0, 0), point(-0, 1)] }]],
  ['one point is discarded', [{ id: 'a', color: '#fff', points: [point(1, 2)] }]],
  ['per-stroke limit', [{ id: 'a', color: '#fff', points: Array.from({ length: 10_001 }, (_, i) => point(i, i)) }]],
  ['total limit', Array.from({ length: 21 }, (_, stroke) => ({
    id: String(stroke), color: '#000', points: Array.from({ length: 10_000 }, (_, i) => point(i, stroke))
  }))],
]

describe('canvas stroke sanitizer equivalence', () => {
  const nativeAvailable = sanitizeStrokesNative([]) !== null

  for (const [name, fixture] of fixtures) {
    test(name, { skip: !nativeAvailable }, () => {
      assert.deepStrictEqual(sanitizeStrokesNative(fixture), sanitizeStrokesJs(fixture))
    })
  }
})

/**
 * The equivalence suite above only runs where the Rust binary was built. This
 * one pins the behaviour of the TypeScript fallback directly, because that is
 * the sanitizer every install without a native build actually uses.
 */
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
