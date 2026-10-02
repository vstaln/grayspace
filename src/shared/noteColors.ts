/**
 * The category-color palette for Notes (and, by extension, the Overview
 * graph's note nodes). Colors reused from the app's existing gray/white/
 * charcoal base (ui/tokens.ts `monochrome`) rather than inventing a second,
 * clashing accent vocabulary against it.
 */
export const NOTE_CATEGORY_PALETTE = [
  '#7aa2f7', // blue
  '#e6c07b', // amber
  '#7fd99a', // green
  '#c792ea', // purple
  '#f87171', // red
  '#38bdf8', // cyan
  '#f783ac', // pink
  '#ffa94d' // orange
] as const

export const DEFAULT_NOTE_COLOR: string = NOTE_CATEGORY_PALETTE[0]
