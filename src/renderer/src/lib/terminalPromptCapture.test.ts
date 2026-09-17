import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { captureTerminalInput, EMPTY_TERMINAL_PROMPT_CAPTURE } from './terminalPromptCapture.ts'

describe('terminal prompt capture', () => {
  test('returns a submitted prompt on Enter', () => {
    const result = captureTerminalInput(EMPTY_TERMINAL_PROMPT_CAPTURE, 'review this\r')
    assert.deepEqual(result.submitted, [{ command: 'review this', prompt: 'review this' }])
    assert.equal(result.capture.prompt, '')
  })

  test('keeps multiline bracketed paste as one prompt across chunks', () => {
    const first = captureTerminalInput(EMPTY_TERMINAL_PROMPT_CAPTURE, '\x1b[200~first\n')
    const second = captureTerminalInput(first.capture, 'second\x1b[201~')
    const submitted = captureTerminalInput(second.capture, '\r')
    assert.deepEqual(submitted.submitted, [{ command: 'second', prompt: 'first\nsecond' }])
  })

  test('applies editing controls and ignores navigation sequences', () => {
    const result = captureTerminalInput(EMPTY_TERMINAL_PROMPT_CAPTURE, 'revieX\x7fw\x1b[D\r')
    assert.deepEqual(result.submitted, [{ command: 'review', prompt: 'review' }])
  })
})
