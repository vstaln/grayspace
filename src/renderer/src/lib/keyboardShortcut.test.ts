import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE_INSERT_SHORTCUT, formatShortcut, matchesShortcut, normalizeShortcut, shortcutFromEvent } from './keyboardShortcut.ts'

const keyEvent = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent => ({
  key: 'i',
  code: 'KeyI',
  ctrlKey: true,
  altKey: false,
  shiftKey: true,
  metaKey: false,
  ...overrides
} as KeyboardEvent)

describe('image widget keyboard shortcut', () => {
  test('normalizes the platform-neutral modifier spelling', () => {
    assert.equal(normalizeShortcut('Ctrl + Shift + i'), 'MOD+SHIFT+I')
    assert.equal(DEFAULT_IMAGE_INSERT_SHORTCUT, 'Mod+Shift+I')
  })

  test('matches physical keys so a non-English keyboard layout still works', () => {
    assert.equal(matchesShortcut(keyEvent({ key: 'ш' }), DEFAULT_IMAGE_INSERT_SHORTCUT), true)
    assert.equal(matchesShortcut(keyEvent({ shiftKey: false }), DEFAULT_IMAGE_INSERT_SHORTCUT), false)
  })

  test('records only modified shortcuts', () => {
    assert.equal(shortcutFromEvent(keyEvent()), 'MOD+SHIFT+I')
    assert.equal(shortcutFromEvent(keyEvent({ ctrlKey: false, shiftKey: false })), null)
  })

  test('formats the stored shortcut for the current platform', () => {
    assert.equal(formatShortcut('Mod+Shift+I'), 'Ctrl+Shift+I')
  })
})
