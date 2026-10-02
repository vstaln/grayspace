import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { APP_OWNED_MODE_RESET, terminalRestoreData } from './terminalRestore.ts'

/**
 * The part of VT cursor semantics the reset touches, as xterm.js implements
 * it: DECSTBM (`CSI r`) and DECOM (`CSI ?6h` / `CSI ?6l`) home the cursor,
 * DECSC (`ESC 7`) saves its position and DECRC (`ESC 8`) restores it.
 */
function cursorRowAfter(sequence: string, startRow: number): number {
  let row = startRow
  let saved = startRow
  const tokens = /\x1b(?:\[([?]?)([\d;]*)([a-zA-Z])|([78]))/g
  for (const match of sequence.matchAll(tokens)) {
    const [, privateMarker, params, final, escFinal] = match
    if (escFinal === '7') saved = row
    else if (escFinal === '8') row = saved
    else if (final === 'r' && !privateMarker) row = 0
    else if ((final === 'h' || final === 'l') && privateMarker === '?' && params.split(';').includes('6')) row = 0
  }
  return row
}

describe('app-owned mode reset', () => {
  it('leaves the cursor on the row the shell prompt is written to', () => {
    // Ctrl+C after a TUI: the shell is about to print its prompt on row 17.
    // Homing the cursor here put that prompt over the old output on row 1.
    assert.equal(cursorRowAfter(APP_OWNED_MODE_RESET, 17), 17)
  })

  it('still resets origin mode and the scrolling region', () => {
    assert.ok(APP_OWNED_MODE_RESET.includes('\x1b[?6l'))
    assert.ok(APP_OWNED_MODE_RESET.includes('\x1b[r'))
    assert.ok(APP_OWNED_MODE_RESET.includes('\x1b[?1049l'))
    // The alternate screen is left before the cursor is saved, so the saved
    // position is the normal buffer's, not the dead application's.
    assert.ok(APP_OWNED_MODE_RESET.indexOf('\x1b[?1049l') < APP_OWNED_MODE_RESET.indexOf('\x1b7'))
  })

  it('prints the restored-session notice below the replayed history', () => {
    assert.equal(cursorRowAfter(terminalRestoreData('history', false), 9), 9)
  })
})
