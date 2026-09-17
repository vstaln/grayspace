import assert from 'node:assert/strict'
import test from 'node:test'
import { codeGridLayout, isCodeLayoutMode } from './codeLayout.ts'

test('auto keeps the view own hand-tuned layout', () => {
  assert.equal(codeGridLayout('auto', 3), null)
  assert.equal(codeGridLayout('auto', 12), null)
})

test('an empty session list has nothing to lay out', () => {
  assert.equal(codeGridLayout('grid', 0), null)
})

test('grid is square-ish and equal', () => {
  assert.equal(codeGridLayout('grid', 4)!.container.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))')
  assert.equal(codeGridLayout('grid', 5)!.container.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))')
  assert.deepEqual(codeGridLayout('grid', 5)!.placement(2), {})
})

test('columns puts every session in its own column, rows in its own row', () => {
  const columns = codeGridLayout('columns', 4)!
  assert.match(columns.container.gridTemplateColumns, /^repeat\(4, minmax\(280px, 1fr\)\)$/)
  const rows = codeGridLayout('rows', 4)!
  assert.equal(rows.container.gridTemplateColumns, 'minmax(0, 1fr)')
  assert.match(rows.container.gridAutoRows!, /^minmax\(180px, 1fr\)$/)
})

test('focus gives the featured card the tall left cell and stacks the rest', () => {
  const layout = codeGridLayout('focus', 4, 2)!
  assert.equal(layout.container.gridTemplateRows, 'repeat(3, minmax(180px, 1fr))')
  assert.deepEqual(layout.placement(2), { gridColumn: '1', gridRow: '1 / span 3' })
  // Slots on the right stay in order and never collide with each other.
  assert.deepEqual(layout.placement(0), { gridColumn: '2', gridRow: '1' })
  assert.deepEqual(layout.placement(1), { gridColumn: '2', gridRow: '2' })
  assert.deepEqual(layout.placement(3), { gridColumn: '2', gridRow: '3' })
})

test('focus falls back to the first card when the featured one is gone', () => {
  const layout = codeGridLayout('focus', 3, 7)!
  assert.deepEqual(layout.placement(0), { gridColumn: '1', gridRow: '1 / span 2' })
  assert.deepEqual(layout.placement(1), { gridColumn: '2', gridRow: '1' })
})

test('a single session fills the view in every mode', () => {
  for (const mode of ['grid', 'columns', 'rows', 'focus'] as const) {
    const layout = codeGridLayout(mode, 1)!
    assert.equal(layout.container.gridTemplateColumns, 'minmax(0, 1fr)')
    assert.deepEqual(layout.placement(0), {})
  }
})

test('isCodeLayoutMode guards persisted values', () => {
  assert.equal(isCodeLayoutMode('focus'), true)
  assert.equal(isCodeLayoutMode('auto'), true)
  assert.equal(isCodeLayoutMode('tiny'), false)
  assert.equal(isCodeLayoutMode(undefined), false)
})
