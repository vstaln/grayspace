import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldReassertCursorBlink } from './terminalCursorBlink.ts'

describe('terminal cursor blink ownership', () => {
  it('leaves a full-screen application alone while it owns the screen', () => {
    assert.equal(shouldReassertCursorBlink({ bufferType: 'alternate', cursorBlink: false }), false)
    assert.equal(shouldReassertCursorBlink({ bufferType: 'alternate', cursorBlink: true }), false)
  })

  it('takes the blink back once the prompt is on screen again', () => {
    // An agent that exited having left DEC mode 12 off.
    assert.equal(shouldReassertCursorBlink({ bufferType: 'normal', cursorBlink: false }), true)
  })

  it('does nothing when the caret already blinks', () => {
    assert.equal(shouldReassertCursorBlink({ bufferType: 'normal', cursorBlink: true }), false)
  })
})
