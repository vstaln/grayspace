import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  blurTerminal,
  clearMountedTerminals,
  focusedTerminalId,
  forgetTerminalMounted,
  isTerminalMounted,
  markTerminalMounted,
  setFocusedTerminal,
  unmarkTerminalMounted
} from './ipc/terminalFocus.ts'

/**
 * `isTerminalMounted` gates `terminal:onData`. If a live widget loses its
 * mark, the main process silently stops forwarding output to it: the terminal
 * still accepts keystrokes and the shell still runs, but nothing is ever
 * painted again — indistinguishable from a hung terminal, and only closing the
 * widget clears it.
 */
describe('terminal mount tracking', () => {
  test('survives a remount whose create is handled before the old detach', () => {
    clearMountedTerminals()
    // Closing one widget re-renders its neighbours; in the code view a
    // 3-session layout is a different subtree, so every survivor remounts.
    markTerminalMounted('term-1')

    // New generation attaches first, old generation detaches afterwards.
    markTerminalMounted('term-1')
    unmarkTerminalMounted('term-1')

    assert.equal(isTerminalMounted('term-1'), true, 'the live widget must keep receiving output')
    clearMountedTerminals()
  })

  test('survives a remount in the ordinary detach-then-create order', () => {
    clearMountedTerminals()
    markTerminalMounted('term-1')

    unmarkTerminalMounted('term-1')
    markTerminalMounted('term-1')

    assert.equal(isTerminalMounted('term-1'), true)
    clearMountedTerminals()
  })

  test('a genuine close leaves the terminal unmounted', () => {
    clearMountedTerminals()
    markTerminalMounted('term-1')
    unmarkTerminalMounted('term-1')
    assert.equal(isTerminalMounted('term-1'), false)

    // Never goes negative: a stray extra detach must not bank credit that
    // would keep the next mount alive after it is closed.
    unmarkTerminalMounted('term-1')
    markTerminalMounted('term-1')
    unmarkTerminalMounted('term-1')
    assert.equal(isTerminalMounted('term-1'), false)
  })

  test('dispose drops every outstanding mount for the id', () => {
    clearMountedTerminals()
    markTerminalMounted('term-1')
    markTerminalMounted('term-1')

    forgetTerminalMounted('term-1')

    assert.equal(isTerminalMounted('term-1'), false)
  })

  test('mount tracking is per terminal', () => {
    clearMountedTerminals()
    markTerminalMounted('term-1')
    markTerminalMounted('term-2')

    forgetTerminalMounted('term-2')

    assert.equal(isTerminalMounted('term-1'), true, 'closing one terminal must not mute another')
    assert.equal(isTerminalMounted('term-2'), false)
    clearMountedTerminals()
  })

  test('a closing widget does not steal focus from the terminal that has it', () => {
    setFocusedTerminal('term-1')
    setFocusedTerminal('term-2')

    // term-1's widget unmounts and reports that it is no longer focused.
    blurTerminal('term-1')

    assert.equal(focusedTerminalId(), 'term-2')

    blurTerminal('term-2')
    assert.equal(focusedTerminalId(), null)
  })
})
