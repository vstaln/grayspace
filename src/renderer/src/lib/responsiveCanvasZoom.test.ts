import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_RESPONSIVE_SCALE,
  isUsableViewport,
  responsiveZoom,
  viewportScale,
  zoomChanged,
  adaptCanvasZoom,
  parseZoomBaseline,
  serializeZoomBaseline,
  type ZoomAdaptationState
} from './responsiveCanvasZoom.ts'
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from './canvasCamera.ts'

const baseline = { zoom: 1, viewport: { w: 1600, h: 900 } }

describe('viewport scale', () => {
  it('is 1 at the size the zoom was chosen at', () => {
    assert.equal(viewportScale(baseline, { w: 1600, h: 900 }), 1)
  })

  it('follows the axis that ran out of room first', () => {
    // Narrow but tall: width decides, or the widgets are still cut off.
    assert.equal(viewportScale(baseline, { w: 800, h: 900 }), 0.5)
    assert.equal(viewportScale(baseline, { w: 1600, h: 450 }), 0.5)
  })

  it('does not magnify a window larger than the baseline', () => {
    assert.equal(viewportScale(baseline, { w: 3200, h: 1800 }), 1)
  })

  it('stops shrinking at the floor', () => {
    assert.equal(viewportScale(baseline, { w: 100, h: 100 }), MIN_RESPONSIVE_SCALE)
  })

  it('ignores a viewport that has not been measured yet', () => {
    assert.equal(viewportScale(baseline, { w: 0, h: 0 }), 1)
    assert.equal(viewportScale({ zoom: 1, viewport: { w: 0, h: 0 } }, { w: 800, h: 600 }), 1)
  })
})

describe('responsive zoom', () => {
  it('returns the chosen zoom at the chosen size', () => {
    assert.equal(responsiveZoom(baseline, { w: 1600, h: 900 }), 1)
  })

  it('halves the zoom for a half-width window', () => {
    assert.equal(responsiveZoom(baseline, { w: 800, h: 900 }), 0.5)
  })

  it('is reversible: shrinking then restoring returns the exact zoom', () => {
    // The whole reason this is derived from a baseline rather than compounded.
    const small = responsiveZoom(baseline, { w: 700, h: 500 })
    const back = responsiveZoom(baseline, { w: 1600, h: 900 })
    assert.notEqual(small, back)
    assert.equal(back, baseline.zoom)
  })

  it('does not depend on the path taken to a size', () => {
    // Dragged smoothly through many sizes, or jumped to the end in one go.
    const steps = [1500, 1300, 1100, 950, 800]
    let last = 0
    for (const w of steps) last = responsiveZoom(baseline, { w, h: 900 })
    assert.equal(last, responsiveZoom(baseline, { w: 800, h: 900 }))
  })

  it('scales a zoom the user had already changed', () => {
    const zoomedOut = { zoom: 0.5, viewport: { w: 1600, h: 900 } }
    assert.equal(responsiveZoom(zoomedOut, { w: 800, h: 900 }), 0.25)
  })

  it('never goes below the canvas minimum zoom', () => {
    const tiny = { zoom: MIN_CANVAS_ZOOM, viewport: { w: 1600, h: 900 } }
    assert.equal(responsiveZoom(tiny, { w: 200, h: 200 }), MIN_CANVAS_ZOOM)
  })
})

describe('viewport usability', () => {
  it('rejects unmeasured and nonsense sizes', () => {
    assert.equal(isUsableViewport({ w: 0, h: 900 }), false)
    assert.equal(isUsableViewport({ w: 1600, h: 0 }), false)
    assert.equal(isUsableViewport({ w: Number.NaN, h: 900 }), false)
    assert.equal(isUsableViewport({ w: 1600, h: 900 }), true)
  })
})

describe('zoom change threshold', () => {
  it('ignores differences too small to see', () => {
    assert.equal(zoomChanged(1, 1.00001), false)
    assert.equal(zoomChanged(1, 1.05), true)
  })
})

/**
 * Drives the adaptation the way the effect does: apply what it asks for, feed
 * the result back in, and keep going until it stops asking. `rounds` is what
 * catches an oscillation — a loop that never settles would run out of them.
 */
function settle(
  state: ZoomAdaptationState | null,
  cameraZoom: number,
  viewport: { w: number; h: number },
  rounds = 8
): { state: ZoomAdaptationState | null; zoom: number; steps: number } {
  let zoom = cameraZoom
  let steps = 0
  for (let i = 0; i < rounds; i++) {
    const step = adaptCanvasZoom(state, zoom, viewport)
    if (step.kind === 'idle') return { state, zoom, steps }
    state = step.state
    steps += 1
    if (step.kind === 'apply') zoom = step.zoom
  }
  throw new Error(`adaptation never settled (last zoom ${zoom})`)
}

describe('adaptation loop', () => {
  const big = { w: 1600, h: 900 }
  const small = { w: 800, h: 900 }

  it('adopts the first measurement without moving the camera', () => {
    const first = settle(null, 1, big)
    assert.equal(first.zoom, 1)
    assert.deepEqual(first.state, { zoom: 1, viewport: big, applied: 1 })
  })

  it('scales down when the window shrinks, and settles', () => {
    const { state } = settle(null, 1, big)
    const shrunk = settle(state, 1, small)
    assert.equal(shrunk.zoom, 0.5)
  })

  it('returns to the exact original zoom when the window grows back', () => {
    const { state: a } = settle(null, 1, big)
    const { state: b, zoom: shrunk } = settle(a, 1, small)
    assert.equal(shrunk, 0.5)
    const grown = settle(b, shrunk, big)
    assert.equal(grown.zoom, 1)
  })

  it('survives a drag through many intermediate sizes', () => {
    let { state } = settle(null, 1, big)
    let zoom = 1
    for (const w of [1500, 1400, 1200, 1000, 900, 800]) {
      const round = settle(state, zoom, { w, h: 900 })
      state = round.state
      zoom = round.zoom
    }
    // Same place as jumping straight there, and back to 1 on the way out.
    assert.equal(zoom, 0.5)
    assert.equal(settle(state, zoom, big).zoom, 1)
  })

  it('treats a deliberate zoom as the new baseline', () => {
    const { state } = settle(null, 1, big)
    // The user zooms out to 0.5 at the big window: that is now what 100% means.
    const rebaselined = settle(state, 0.5, big)
    assert.equal(rebaselined.zoom, 0.5)
    assert.deepEqual(rebaselined.state, { zoom: 0.5, viewport: big, applied: 0.5 })
    // Halving the window from there halves that choice, not the original 1.
    assert.equal(settle(rebaselined.state, 0.5, small).zoom, 0.25)
  })

  it('does nothing until the viewport has been measured', () => {
    const step = adaptCanvasZoom(null, 1, { w: 0, h: 0 })
    assert.equal(step.kind, 'idle')
  })

  it('reads a damaged camera zoom as neutral instead of adopting it', () => {
    // Adopting 0 as the baseline would multiply every later viewport against
    // it and wedge the canvas at the minimum zoom for the whole session.
    for (const broken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const step = adaptCanvasZoom(null, broken, big)
      assert.equal(step.kind, 'rebaseline', String(broken))
      assert.equal(step.kind === 'rebaseline' && step.state.zoom, 1, String(broken))
    }
  })

  it('never asks for a zoom the camera would clamp away', () => {
    // The loop recognises its own write by value, so a zoom the camera clamps
    // on the way in would never match what was recorded as applied — and every
    // following frame would re-baseline, making the shrink permanent.
    for (const baseZoom of [MIN_CANVAS_ZOOM, 0.3, 1, 4]) {
      for (const w of [3200, 1600, 900, 400, 120]) {
        const state = { zoom: baseZoom, viewport: big, applied: baseZoom }
        const step = adaptCanvasZoom(state, baseZoom, { w, h: 900 })
        if (step.kind !== 'apply') continue
        assert.ok(step.zoom >= MIN_CANVAS_ZOOM, `${step.zoom} under min`)
        assert.ok(step.zoom <= MAX_CANVAS_ZOOM, `${step.zoom} over max`)
      }
    }
  })

  it('reaches a fixed point in one applied step', () => {
    const { state } = settle(null, 1, big)
    // One 'apply', then 'idle': the loop recognises its own write.
    assert.equal(settle(state, 1, small).steps, 1)
  })

  it('survives a restart without making the shrink permanent', () => {
    // End a session in a small window: the camera saved to disk is 0.5.
    const { state: atBig } = settle(null, 1, big)
    const shrunk = settle(atBig, 1, small)
    assert.equal(shrunk.zoom, 0.5)

    // Relaunch: the camera comes back as 0.5, the baseline from storage.
    const restored = parseZoomBaseline(serializeZoomBaseline(shrunk.state!))
    const reopened = settle(restored, 0.5, small)
    assert.equal(reopened.zoom, 0.5, 'reopening at the same size looks identical')

    // Enlarging now undoes the shrink, which is the whole point of storing it.
    assert.equal(settle(reopened.state, 0.5, big).zoom, 1)
  })
})

describe('baseline storage', () => {
  it('round-trips a baseline', () => {
    const state = { zoom: 0.8, viewport: { w: 1440, h: 810 }, applied: 0.4 }
    assert.deepEqual(parseZoomBaseline(serializeZoomBaseline(state)), state)
  })

  it('discards anything unusable rather than repairing it', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '[]',
      '{"zoom":0,"w":100,"h":100,"applied":1}',
      '{"zoom":1,"w":-5,"h":100,"applied":1}',
      '{"zoom":1,"w":100,"h":100}',
      '{"zoom":"1","w":100,"h":100,"applied":1}'
    ]) {
      assert.equal(parseZoomBaseline(raw), null, String(raw))
    }
  })
})
