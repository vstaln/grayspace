import assert from 'node:assert/strict'
import test from 'node:test'
import { arrangeWidgets, fitSpawnSize, isArrangeMode, LAYOUT_GAP, type LayoutRect, type LayoutViewport } from './canvasLayout.ts'
import { MIN_H, MIN_W, WIDGET_DEFAULTS, type Widget } from '../types.ts'

const VIEWPORT: LayoutViewport = { x: 0, y: 0, w: 1600, h: 900 }

function widgetsOf(count: number): Widget[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `w${i}`,
    title: `Widget ${i}`,
    kind: 'terminal' as const,
    x: 0,
    y: 0,
    w: 680,
    h: 420,
    z: i + 1
  }))
}

function overlaps(a: LayoutRect, b: LayoutRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function anyOverlap(rects: LayoutRect[]): boolean {
  return rects.some((a, i) => rects.slice(i + 1).some((b) => overlaps(a, b)))
}

test('grid lays widgets out in a square-ish grid inside the viewport', () => {
  const rects = arrangeWidgets(widgetsOf(4), VIEWPORT, 'grid')
  assert.equal(rects.length, 4)
  assert.equal(anyOverlap(rects), false)
  const columns = new Set(rects.map((r) => r.x)).size
  assert.equal(columns, 2)
  for (const rect of rects) {
    assert.ok(rect.x >= VIEWPORT.x + LAYOUT_GAP)
    assert.ok(rect.y >= VIEWPORT.y + LAYOUT_GAP)
    assert.ok(rect.x + rect.w <= VIEWPORT.x + VIEWPORT.w)
    assert.ok(rect.y + rect.h <= VIEWPORT.y + VIEWPORT.h)
  }
})

test('grid honours the viewport origin so it lands on screen when panned', () => {
  const rects = arrangeWidgets(widgetsOf(2), { x: -400, y: 250, w: 1600, h: 900 }, 'grid')
  assert.equal(rects[0].x, -400 + LAYOUT_GAP)
  assert.equal(rects[0].y, 250 + LAYOUT_GAP)
})

test('tiny packs more columns of smaller tiles than grid', () => {
  const widgets = widgetsOf(8)
  const grid = arrangeWidgets(widgets, VIEWPORT, 'grid')
  const tiny = arrangeWidgets(widgets, VIEWPORT, 'tiny')
  assert.equal(tiny.length, 8)
  assert.equal(anyOverlap(tiny), false)
  assert.ok(new Set(tiny.map((r) => r.x)).size > new Set(grid.map((r) => r.x)).size)
  assert.ok(tiny[0].w < grid[0].w)
})

test('focus gives the named widget the wide tile and stacks the rest beside it', () => {
  const rects = arrangeWidgets(widgetsOf(4), VIEWPORT, 'focus', 'w1')
  assert.equal(anyOverlap(rects), false)
  const main = rects.find((r) => r.id === 'w1')!
  const side = rects.filter((r) => r.id !== 'w1')
  assert.ok(side.every((r) => r.w < main.w))
  assert.ok(side.every((r) => r.x > main.x + main.w - 1))
  assert.equal(new Set(side.map((r) => r.x)).size, 1)
})

test('focus without an id blows up the topmost widget of the z-stack', () => {
  const rects = arrangeWidgets(widgetsOf(3), VIEWPORT, 'focus')
  const widest = rects.slice().sort((a, b) => b.w - a.w)[0]
  assert.equal(widest.id, 'w2')
})

test('focus with a single widget fills the viewport', () => {
  const [only] = arrangeWidgets(widgetsOf(1), VIEWPORT, 'focus')
  assert.equal(only.w, VIEWPORT.w - LAYOUT_GAP * 2)
  assert.equal(only.h, VIEWPORT.h - LAYOUT_GAP * 2)
})

test('tiles never shrink below a widget minimum, even in a cramped viewport', () => {
  const rects = arrangeWidgets(widgetsOf(6), { x: 0, y: 0, w: 400, h: 300 }, 'grid')
  assert.ok(rects.every((r) => r.w >= MIN_W && r.h >= MIN_H))
  // The cell also drives the row/column offsets: a viewport smaller than the
  // grid it has to hold must still spread the tiles out, not pile them up.
  assert.equal(anyOverlap(rects), false)
})

test('a viewport too small for even one tile still lays out without overlap', () => {
  const rects = arrangeWidgets(widgetsOf(4), { x: 0, y: 0, w: 120, h: 90 }, 'grid')
  assert.equal(rects.length, 4)
  assert.equal(anyOverlap(rects), false)
})

test('nothing to arrange is a no-op', () => {
  assert.deepEqual(arrangeWidgets([], VIEWPORT, 'grid'), [])
  assert.deepEqual(arrangeWidgets(widgetsOf(3), { x: 0, y: 0, w: 0, h: 0 }, 'grid'), [])
})

test('isArrangeMode guards persisted values', () => {
  assert.equal(isArrangeMode('tiny'), true)
  assert.equal(isArrangeMode('free'), true)
  assert.equal(isArrangeMode('cascade'), false)
  assert.equal(isArrangeMode(null), false)
})

test('fitSpawnSize keeps kind defaults on a roomy viewport', () => {
  assert.deepEqual(fitSpawnSize('terminal', 1920, 1080, 1), { w: WIDGET_DEFAULTS.terminal.w, h: WIDGET_DEFAULTS.terminal.h })
  assert.deepEqual(fitSpawnSize('browser', 1920, 1080, 1), { w: WIDGET_DEFAULTS.browser.w, h: WIDGET_DEFAULTS.browser.h })
})

test('fitSpawnSize shrinks the spawn to a small window instead of cropping it', () => {
  const size = fitSpawnSize('terminal', 500, 400, 1)
  assert.ok(size.w < WIDGET_DEFAULTS.terminal.w)
  assert.ok(size.h < WIDGET_DEFAULTS.terminal.h)
  assert.ok(size.w >= MIN_W && size.h >= MIN_H)
})

test('fitSpawnSize accounts for zoom: world units shrink as zoom grows', () => {
  const roomy = fitSpawnSize('terminal', 1920, 1080, 1)
  const zoomed = fitSpawnSize('terminal', 1920, 1080, 4)
  assert.deepEqual(roomy, { w: WIDGET_DEFAULTS.terminal.w, h: WIDGET_DEFAULTS.terminal.h })
  assert.ok(zoomed.w < roomy.w && zoomed.h < roomy.h)
})

test('fitSpawnSize never goes below the widget minimums', () => {
  assert.deepEqual(fitSpawnSize('terminal', 200, 120, 1), { w: MIN_W, h: MIN_H })
})

test('fitSpawnSize falls back to terminal defaults for unknown kinds', () => {
  assert.deepEqual(fitSpawnSize('mystery-kind', 1920, 1080, 1), { w: WIDGET_DEFAULTS.terminal.w, h: WIDGET_DEFAULTS.terminal.h })
})

test('no arrange mode ever stacks two widgets on each other', () => {
  // focus measured the side column's left edge from an unclamped main width,
  // while tile() widens anything under MIN_W to MIN_W — so in a viewport
  // narrower than about 448 units the focused widget's real right edge ran
  // straight over every card in the side column. A zoomed-in canvas reaches
  // that at an ordinary window size.
  for (const mode of ['grid', 'tiny', 'focus'] as const) {
    for (const width of [200, 300, 420, 447, 448, 640, 1600, 3200]) {
      for (const count of [2, 3, 5, 9, 18]) {
        const rects = arrangeWidgets(widgetsOf(count), { x: 0, y: 0, w: width, h: 600 }, mode)
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            assert.equal(
              overlaps(rects[i], rects[j]),
              false,
              `${mode} at ${width}px with ${count} widgets: ${rects[i].id} overlaps ${rects[j].id}`
            )
          }
        }
      }
    }
  }
})

test('focus keeps the side column clear of the focused widget', () => {
  const rects = arrangeWidgets(widgetsOf(4), { x: 0, y: 0, w: 300, h: 600 }, 'focus', 'w0')
  const main = rects.find((r) => r.id === 'w0')!
  const mainRight = main.x + main.w
  for (const side of rects.filter((r) => r.id !== 'w0')) {
    assert.ok(side.x >= mainRight, `side card ${side.x} starts before the focused widget ends ${mainRight}`)
  }
})
