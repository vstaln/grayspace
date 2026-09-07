/**
 * Everything that can sit on the canvas. `terminal` owns external state (a
 * PTY); the rest render from state the app
 * already has, which is why they need no id of their own beyond the widget's.
 */
export type WidgetKind = 'terminal' | 'timer' | 'board' | 'planner' | 'files' | 'sys-monitor' | 'browser' | 'links' | 'music-player' | 'orchestration'

export interface Widget {
  id: string
  title: string
  kind?: WidgetKind
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

/** Widget kinds that must never enter fullscreen — filling the canvas with
 *  them is just empty space. Single source of truth: WidgetFrame hides the
 *  maximize button via this set, App's toggle/resize paths guard with it. */
export const NON_MAXIMIZABLE: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'files',
  'music-player',
  'orchestration'
])

/** Default title and size per widget type — single source, used by useCanvas.addWidget and App.placeWidget. */
export const WIDGET_DEFAULTS: Record<WidgetKind, { title: string; w: number; h: number }> = {
  terminal: { title: 'Terminal', w: WIDGET_W, h: WIDGET_H },
  timer: { title: 'Timer', w: 300, h: 220 },
  board: { title: 'Task Board', w: 900, h: 520 },
  planner: { title: 'Planner', w: 420, h: 520 },
  files: { title: 'Files', w: 580, h: 480 },
  'sys-monitor': { title: 'System Monitor', w: 460, h: 380 },
  browser: { title: 'Browser', w: 720, h: 480 },
  links: { title: 'Links', w: 420, h: 360 },
  'music-player': { title: 'Music Player', w: 460, h: 420 },
  orchestration: { title: 'Orchestration', w: 520, h: 560 }
}

/**
 * Clamp a default widget size to the current viewport (minus a 32px margin)
 * while never going below MIN_W/MIN_H. Used on create so a large default
 * (e.g. 900px board) cannot spawn larger than a small window.
 */
export function coerceWidgetSize(w: number, h: number, vw: number, vh: number): { w: number; h: number } {
  const maxW = Math.max(MIN_W, (vw || 0) - 32)
  const maxH = Math.max(MIN_H, (vh || 0) - 32)
  return {
    w: Math.min(Math.max(w, MIN_W), maxW),
    h: Math.min(Math.max(h, MIN_H), maxH)
  }
}

/** Alias kept for callers using the older name. */
export const clampDefaultSize = coerceWidgetSize
