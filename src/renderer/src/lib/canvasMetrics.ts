/**
 * Below this many SCREEN px of pointer movement, a draw-tool press/release
 * reads as a click rather than an intentional stroke (CANV-dot): App drops
 * those gestures instead of persisting them.
 *
 * StrokesLayer must paint every stroke that survives that gate, so its
 * "is this a real mark" filter derives from the same number. The two used to
 * disagree (persist 4px, render 12px), silently saving short-but-deliberate
 * marks that never appeared — phantom ink the eraser could not see either
 * (UI-audit P1).
 */
export const DRAW_CLICK_THRESHOLD_PX = 4
