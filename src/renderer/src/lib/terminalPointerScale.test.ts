import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { isPointerScaled, pointerScale, unscalePointer } from './terminalPointerScale.ts'

describe('terminal pointer scale', () => {
  test('the scale is the ratio between the on-screen and laid-out width', () => {
    assert.equal(pointerScale(831, 665), 831 / 665)
    assert.equal(pointerScale(665, 665), 1)
  })

  test('a width that cannot be measured yet leaves the pointer alone', () => {
    for (const [screen, layout] of [[0, 0], [100, 0], [Number.NaN, 400], [100, Number.NaN]]) {
      assert.equal(pointerScale(screen, layout), 1)
    }
    assert.equal(isPointerScaled(1), false)
    assert.equal(isPointerScaled(Number.NaN), false)
    assert.equal(isPointerScaled(0), false)
  })

  test('a scaled pointer maps back onto the cell it is really over', () => {
    // A 15px row drawn at 18.75px on screen: the pointer four rows down sits at
    // 75px on screen, which xterm must be told is 60px to land on row four.
    const rect = { left: 100, top: 200 }
    const scaled = unscalePointer(rect, 1.25, 100 + 75, 200 + 75)
    assert.equal(scaled.clientX, 160)
    assert.equal(scaled.clientY, 260)

    const shrunk = unscalePointer(rect, 0.8, 100 + 48, 200 + 48)
    assert.equal(shrunk.clientX, 160)
    assert.equal(shrunk.clientY, 260)
  })

  test('the origin of the element is a fixed point at any scale', () => {
    const rect = { left: 42, top: 17 }
    for (const scale of [0.5, 1, 1.25, 3]) {
      const mapped = unscalePointer(rect, scale, 42, 17)
      assert.deepEqual(mapped, { clientX: 42, clientY: 17 })
    }
  })

  test('an unscaled canvas is passed through untouched', () => {
    const rect = { left: 10, top: 10 }
    assert.deepEqual(unscalePointer(rect, 1, 123, 456), { clientX: 123, clientY: 456 })
    // Sub-pixel rounding in getBoundingClientRect must not start rewriting events.
    assert.deepEqual(unscalePointer(rect, 1.0005, 123, 456), { clientX: 123, clientY: 456 })
  })
})
