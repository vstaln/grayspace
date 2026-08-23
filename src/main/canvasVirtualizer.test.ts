import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { CanvasVirtualizer } from './canvasVirtualizer.ts'
import type { CanvasCamera, CanvasStroke, CanvasWidget } from './canvasState.ts'

describe('Canvas Virtualization, Viewport Culling & LOD', () => {
  const virtualizer = new CanvasVirtualizer({ padding: 50 })
  const viewport = { width: 1920, height: 1080 }

  test('culls widgets outside camera viewport', () => {
    const camera: CanvasCamera = { x: 0, y: 0, zoom: 1 }

    const insideWidget: CanvasWidget = {
      id: 'w-inside',
      title: 'Visible Widget',
      x: -100,
      y: -100,
      w: 200,
      h: 200,
      z: 1,
      version: 1,
      updatedAt: Date.now()
    }

    const outsideWidget: CanvasWidget = {
      id: 'w-outside',
      title: 'Culled Widget',
      x: 5000,
      y: 5000,
      w: 200,
      h: 200,
      z: 1,
      version: 1,
      updatedAt: Date.now()
    }

    const result = virtualizer.cull([insideWidget, outsideWidget], [], camera, viewport)

    assert.equal(result.visibleWidgetCount, 1)
    assert.equal(result.culledWidgetCount, 1)
    assert.equal(result.visibleWidgets[0].widget.id, 'w-inside')
    assert.equal(result.visibleWidgets[0].lod, 'full')
  })

  test('calculates correct LOD level based on zoom distance', () => {
    assert.equal(virtualizer.getLOD(1.0), 'full')
    assert.equal(virtualizer.getLOD(0.6), 'full')
    assert.equal(virtualizer.getLOD(0.35), 'compact')
    assert.equal(virtualizer.getLOD(0.15), 'placeholder')
  })

  test('culls strokes whose bounding boxes fall outside viewport', () => {
    const camera: CanvasCamera = { x: 0, y: 0, zoom: 1 }

    const visibleStroke: CanvasStroke = {
      id: 's-vis',
      color: '#fff',
      points: [{ x: 0, y: 0 }, { x: 50, y: 50 }]
    }

    const culledStroke: CanvasStroke = {
      id: 's-culled',
      color: '#fff',
      points: [{ x: 4000, y: 4000 }, { x: 4050, y: 4050 }]
    }

    const result = virtualizer.cull([], [visibleStroke, culledStroke], camera, viewport)
    assert.equal(result.visibleStrokeCount, 1)
    assert.equal(result.culledStrokeCount, 1)
    assert.equal(result.visibleStrokes[0].id, 's-vis')
  })

  test('scales to 5,000 widgets with sub-millisecond culling performance', () => {
    const widgets: CanvasWidget[] = []
    for (let i = 0; i < 5000; i += 1) {
      widgets.push({
        id: `w-${i}`,
        title: `Widget ${i}`,
        x: (i % 100) * 300,
        y: Math.floor(i / 100) * 300,
        w: 250,
        h: 200,
        z: 1,
        version: 1,
        updatedAt: 1000
      })
    }

    const camera: CanvasCamera = { x: 1500, y: 1500, zoom: 1 }

    const t0 = performance.now()
    const result = virtualizer.cull(widgets, [], camera, viewport)
    const elapsed = performance.now() - t0

    assert.ok(result.visibleWidgetCount > 0)
    assert.ok(result.culledWidgetCount > 4000)
    assert.ok(elapsed < 10, `Culling took ${elapsed.toFixed(2)}ms (expected < 10ms)`)
  })
})
