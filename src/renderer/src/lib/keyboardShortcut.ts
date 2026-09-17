import { IS_MAC } from './platform.ts'

export const DEFAULT_IMAGE_INSERT_SHORTCUT = 'Mod+Shift+I'

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

const MODIFIERS = new Set(['MOD', 'CTRL', 'ALT', 'SHIFT', 'META'])

function eventKey(event: ShortcutEvent): string {
  if (/^(Key|Digit|Numpad)/.test(event.code)) return event.code.replace(/^(Key|Digit|Numpad)/, '').toUpperCase()
  return event.key.length === 1 ? event.key.toUpperCase() : event.key.toUpperCase()
}

export function normalizeShortcut(value: string): string | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > 5) return null
  const modifiers = new Set<string>()
  let key = ''
  for (const raw of parts) {
    const part = raw.toUpperCase()
    if (MODIFIERS.has(part)) {
      if (part === 'CTRL' || part === 'META') modifiers.add('MOD')
      else modifiers.add(part)
    } else if (key) {
      return null
    } else {
      key = part.length === 1 ? part : part
    }
  }
  if (!key || modifiers.size === 0) return null
  const ordered = ['MOD', 'CTRL', 'ALT', 'SHIFT'].filter((modifier) => modifiers.has(modifier))
  return [...ordered, key].join('+')
}

export function shortcutFromEvent(event: ShortcutEvent): string | null {
  if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return null
  const modifiers: string[] = []
  if (event.ctrlKey || event.metaKey) modifiers.push('MOD')
  if (event.altKey) modifiers.push('ALT')
  if (event.shiftKey) modifiers.push('SHIFT')
  return normalizeShortcut([...modifiers, eventKey(event)].join('+'))
}

export function matchesShortcut(event: ShortcutEvent, configured: string | undefined): boolean {
  const normalized = normalizeShortcut(configured || DEFAULT_IMAGE_INSERT_SHORTCUT)
  if (!normalized) return false
  const parts = normalized.split('+')
  const key = parts.pop()
  if (!key || eventKey(event) !== key) return false
  const expected = new Set(parts)
  const actual = new Set<string>()
  if ((IS_MAC ? event.metaKey : event.ctrlKey)) actual.add('MOD')
  if (event.altKey) actual.add('ALT')
  if (event.shiftKey) actual.add('SHIFT')
  if (IS_MAC ? event.ctrlKey : event.metaKey) actual.add('CTRL')
  return expected.size === actual.size && [...expected].every((modifier) => actual.has(modifier))
}

export function formatShortcut(configured: string | undefined): string {
  const normalized = normalizeShortcut(configured || DEFAULT_IMAGE_INSERT_SHORTCUT) || DEFAULT_IMAGE_INSERT_SHORTCUT
  return normalized
    .split('+')
    .map((part) => part === 'MOD' ? (IS_MAC ? '⌘' : 'Ctrl') : part === 'SHIFT' ? (IS_MAC ? '⇧' : 'Shift') : part === 'ALT' ? (IS_MAC ? '⌥' : 'Alt') : part)
    .join(IS_MAC ? '' : '+')
}
