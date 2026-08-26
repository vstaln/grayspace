/**
 * Platform facts the UI has to branch on, resolved once at module load.
 *
 * The renderer is sandboxed and has no `process`, so this reads the UA rather
 * than IPC: every consumer here is a keyboard handler or a class name, and both
 * run long before an async platform lookup could resolve.
 */

/** True on macOS, where the primary chord modifier is Command, not Control. */
export const IS_MAC: boolean =
  typeof navigator !== 'undefined' &&
  // userAgentData is the modern surface; platform is the fallback that still
  // reports "MacIntel" on Apple Silicon under Electron.
  (((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '')
    .toLowerCase()
    .includes('mac'))

/**
 * Whether an event carries the platform's primary chord modifier — Command on
 * macOS, Control everywhere else. Use this for app shortcuts (copy, paste,
 * select-all, zoom, close) so a Mac user never has to reach for Control.
 */
export function hasPrimaryModifier(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'> | Pick<MouseEvent, 'ctrlKey' | 'metaKey'>
): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey
}

/**
 * The inverse guard: true when the *other* platform's modifier is held on its
 * own. A Mac shortcut must not also fire on Control, and a Windows one must not
 * fire on the Windows key, or a chord like Ctrl+A inside a terminal would be
 * swallowed by the app instead of reaching the shell.
 */
export function hasSecondaryModifier(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>
): boolean {
  return IS_MAC ? event.ctrlKey : event.metaKey
}

/** Label for the primary modifier, for hints and tooltips. */
export const PRIMARY_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl'

/** Label for Alt, which macOS names and prints differently. */
export const ALT_KEY_LABEL = IS_MAC ? '⌥' : 'Alt'

/** Label for Shift, spelled out off macOS. */
export const SHIFT_KEY_LABEL = IS_MAC ? '⇧' : 'Shift'

/**
 * Render a chord for display: `shortcut('V')` → `⌘V` on macOS, `Ctrl+V`
 * elsewhere. macOS convention joins the glyphs with no separator.
 */
export function shortcut(key: string, options?: { shift?: boolean; alt?: boolean }): string {
  const parts: string[] = [PRIMARY_KEY_LABEL]
  if (options?.alt) parts.push(ALT_KEY_LABEL)
  if (options?.shift) parts.push(SHIFT_KEY_LABEL)
  parts.push(key)
  return IS_MAC ? parts.join('') : parts.join('+')
}
