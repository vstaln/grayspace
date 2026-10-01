/**
 * The category-color palette for Notes (and, by extension, the Overview
 * graph's note nodes). Colors already in circulation elsewhere in the app —
 * SysMonitorWidget's CPU/RAM/limit indicators — reused here rather than
 * inventing a second, clashing accent vocabulary against the same
 * gray/white/charcoal base (ui/tokens.ts `monochrome`).
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
