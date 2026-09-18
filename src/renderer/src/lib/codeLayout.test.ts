import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_LAYOUT_MODES,
  autoCodeLayout,
  codeGridLayout,
  denseRowCounts,
  isCodeLayoutMode
} from './codeLayout.ts'

/** The Code view's own ceiling, from CodeLauncher. */
const MAX_SESSIONS = 32
const SPLIT = { col: 50, row: 50 }

/** `repeat(N, …)` or an explicit track list — how many tracks does it declare? */
function columnCount(template: string): number {
  const repeat = /^repeat\((\d+),/.exec(template)
  if (repeat) return Number(repeat[1])
  return template.trim().split(/\s+/).length
}

/** Largest column a placement occupies, or 0 when it leaves placement to grid. */
function lastColumn(placement: { gridColumn?: string }): number {
  const value = placement.gridColumn
  if (!value) return 0
  const span = /^(\d+) \/ span (\d+)$/.exec(value)
  if (span) return Number(span[1]) + Number(span[2]) - 1
  const single = /^(\d+)$/.exec(value)
  return single ? Number(single[1]) : 0
}

describe('code layout modes', () => {
  it('recognises exactly the modes it offers', () => {
    for (const mode of CODE_LAYOUT_MODES) assert.equal(isCodeLayoutMode(mode), true)
    for (const other of ['', 'Grid', 'tiled', null, 7, {}]) {
      assert.equal(isCodeLayoutMode(other), false, String(other))
    }
  })
})

describe('dense row counts', () => {
  it('accounts for every card exactly once', () => {
    for (let count = 6; count <= 20; count += 1) {
      const rows = denseRowCounts(count)
      assert.equal(rows.reduce((a, b) => a + b, 0), count, `count ${count}`)
      assert.ok(rows.every((n) => n > 0), `count ${count} has an empty row`)
    }
  })

  it('only ever produces row sizes the dense grid divides evenly', () => {
    // A row size that does not divide the column count would give a card a
    // fractional span and leave a seam down the grid.
    for (let count = 6; count <= 20; count += 1) {
      for (const inRow of denseRowCounts(count)) {
        assert.equal(60 % inRow, 0, `count ${count}: row of ${inRow} does not divide 60`)
      }
    }
  })
})

describe('auto layout', () => {
  it('keeps every card inside the columns it declares', () => {
    for (let count = 1; count <= MAX_SESSIONS; count += 1) {
      const layout = autoCodeLayout(count, SPLIT)
      const columns = columnCount(layout.container.gridTemplateColumns)
      for (let index = 0; index < count; index += 1) {
        const last = lastColumn(layout.placement(index))
        assert.ok(last <= columns, `count ${count}, card ${index}: column ${last} > ${columns}`)
      }
    }
  })

  it('gives every card a row template or auto rows to land in', () => {
    for (let count = 1; count <= MAX_SESSIONS; count += 1) {
      const { container } = autoCodeLayout(count, SPLIT)
      assert.ok(
        container.gridAutoRows || container.gridTemplateRows,
        `count ${count} declares neither auto rows nor a row template`
      )
    }
  })

  it('never hands two cards the same cell in the explicit layouts', () => {
    // Counts 3, 5 and 6–20 place every card by hand; an overlap there is two
    // terminals stacked on one another.
    for (const count of [3, 5, ...Array.from({ length: 15 }, (_, i) => i + 6)]) {
      const layout = autoCodeLayout(count, SPLIT)
      const taken = new Set<string>()
      for (let index = 0; index < count; index += 1) {
        const { gridColumn, gridRow } = layout.placement(index)
        if (!gridColumn || !gridRow) continue
        const cell = `${gridColumn}@${gridRow}`
        assert.equal(taken.has(cell), false, `count ${count}: ${cell} used twice`)
        taken.add(cell)
      }
    }
  })

  it('places the draggable split against the tracks it declares', () => {
    const layout = autoCodeLayout(3, { col: 30, row: 70 })
    assert.equal(layout.container.gridTemplateColumns, 'minmax(0, 30fr) 2px minmax(0, 70fr)')
    assert.equal(layout.container.gridTemplateRows, 'minmax(0, 70fr) 2px minmax(0, 30fr)')
    // The tall card owns the whole left column; the separators are tracks 2.
    assert.deepEqual(layout.placement(0), { gridColumn: '1', gridRow: '1 / 4' })
    assert.deepEqual(layout.placement(1), { gridColumn: '3', gridRow: '1' })
    assert.deepEqual(layout.placement(2), { gridColumn: '3', gridRow: '3' })
  })
})

describe('explicit layout modes', () => {
  it('leaves auto to the caller', () => {
    assert.equal(codeGridLayout('auto', 5), null)
    assert.equal(codeGridLayout('grid', 0), null)
  })

  it('keeps every card inside the columns it declares', () => {
    for (const mode of ['grid', 'columns', 'rows', 'focus'] as const) {
      for (let count = 1; count <= MAX_SESSIONS; count += 1) {
        const layout = codeGridLayout(mode, count)
        assert.ok(layout, `${mode}/${count} returned null`)
        const columns = columnCount(layout.container.gridTemplateColumns)
        for (let index = 0; index < count; index += 1) {
          const last = lastColumn(layout.placement(index))
          assert.ok(last <= columns, `${mode}/${count} card ${index}: column ${last} > ${columns}`)
        }
      }
    }
  })

  it('focus gives the focused card the main cell wherever it sits', () => {
    for (let count = 2; count <= 8; count += 1) {
      for (let focus = 0; focus < count; focus += 1) {
        const layout = codeGridLayout('focus', count, focus)
        assert.ok(layout)
        assert.equal(layout.placement(focus).gridColumn, '1', `count ${count}, focus ${focus}`)
        const sideRows = new Set<string>()
        for (let index = 0; index < count; index += 1) {
          if (index === focus) continue
          const { gridColumn, gridRow } = layout.placement(index)
          assert.equal(gridColumn, '2', `count ${count}: card ${index} not in the side column`)
          assert.equal(sideRows.has(String(gridRow)), false, `count ${count}: row ${gridRow} used twice`)
          sideRows.add(String(gridRow))
        }
      }
    }
  })

  it('falls back to the first card when focus is out of range', () => {
    for (const focus of [-1, 99, Number.NaN]) {
      const layout = codeGridLayout('focus', 4, focus)
      assert.ok(layout)
      assert.equal(layout.placement(0).gridColumn, '1', String(focus))
    }
  })
})
