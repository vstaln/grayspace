/**
 * Everything that can sit on the canvas. `terminal` and `note` own external
 * state (a PTY, a note in the brain); the rest render from state the app
 * already has, which is why they need no id of their own beyond the widget's.
 */
export type WidgetKind = 'terminal' | 'note' | 'timer' | 'board' | 'planner' | 'files' | 'sys-monitor' | 'browser'

export interface Widget {
  id: string
  title: string
  kind?: WidgetKind
  noteId?: string
  x: number
  y: number
  w: number
  h: number
  z: number
  maximized?: boolean
  /**
   * Version the main process last stamped on this widget. Carried through the
   * canvas untouched and sent back on save: it is how the merge on the other
   * side tells this window echoing back its own layout apart from an agent
   * having moved the widget in the meantime.
   */
  version?: number
  updatedAt?: number
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface Point {
  x: number
  y: number
}

/** A freehand pencil stroke on the canvas, in world coordinates. */
export interface Stroke {
  id: string
  points: Point[]
  color: string
}

/**
 * "This shell opened that one." Drawn as a lit arc between the two widgets so
 * a canvas full of terminals still reads as a tree rather than a pile: when an
 * agent runs `opencode` in a new window, the line is the only thing that says
 * where it came from.
 *
 * Deliberately not persisted — it describes a live process relationship, and
 * after a restart both ptys are dead and the claim would be a lie.
 */
export interface Connection {
  id: string
  from: string
  to: string
  /** When it was created, so the arrival flare can play once and settle. */
  bornAt: number
}

export type CanvasTool = 'select' | 'pan' | 'draw' | 'erase'

/** Preset palette for the pencil tool, shown as swatches in the toolbar. */
export const STROKE_COLORS = [
  '#ffffff',
  '#ff6b6b',
  '#ffa94d',
  '#ffd43b',
  '#69db7c',
  '#4dabf7',
  '#b197fc',
  '#f783ac'
] as const

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const RESIZE_HANDLES: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

export const MIN_W = 280
export const MIN_H = 160
export const WIDGET_W = 680
export const WIDGET_H = 420
// Must match the widget header height in WidgetFrame (h-[34px]) — used to
// offset the maximized widget's top inset so it sits flush under the chrome
// (CANV-20).
export const HEADER_H = 34
