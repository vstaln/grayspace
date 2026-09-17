/**
 * Who owns the caret's blink.
 *
 * DEC private mode 12 switches blinking off, and xterm applies it straight to
 * `options.cursorBlink`. A full-screen agent may legitimately want a steady
 * caret while it paints — Codex turns mode 12 off and on as it redraws its
 * composer — so the widget must not fight it there.
 *
 * What it must not inherit is the *leftover*: leaving the alternate buffer does
 * not restore mode 12 (verified against xterm 5.x), so an agent that exits
 * having switched it off hands the shell prompt a caret that never blinks
 * again, for the rest of the session.
 *
 * The buffer is the ownership line. On the alternate buffer the application
 * owns the screen and the caret with it; back on the normal buffer the prompt
 * belongs to the widget, which asks for a blinking caret.
 */
export function shouldReassertCursorBlink(state: {
  bufferType: 'normal' | 'alternate'
  cursorBlink: boolean
}): boolean {
  if (state.bufferType === 'alternate') return false
  return !state.cursorBlink
}
