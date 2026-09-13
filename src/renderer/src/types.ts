




export type WidgetKind = 'terminal' | 'timer' | 'planner' | 'files' | 'sys-monitor' | 'browser' | 'links' | 'music-player' | 'orchestration' | 'chat'

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


export interface Stroke {
  id: string
  points: Point[]
  color: string
}










export interface Connection {
  id: string
  from: string
  to: string

  bornAt: number
}

export type CanvasTool = 'select' | 'pan' | 'draw' | 'erase'


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




export const NON_MAXIMIZABLE: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'files',
  'music-player',
  'orchestration'
])


export const WIDGET_DEFAULTS: Record<WidgetKind, { title: string; w: number; h: number }> = {
  terminal: { title: 'Terminal', w: WIDGET_W, h: WIDGET_H },
  timer: { title: 'Timer', w: 300, h: 220 },
  planner: { title: 'Planner', w: 420, h: 520 },
  files: { title: 'Files', w: 580, h: 480 },
  'sys-monitor': { title: 'System Monitor', w: 460, h: 380 },
  browser: { title: 'Browser', w: 720, h: 480 },
  links: { title: 'Links', w: 420, h: 360 },
  'music-player': { title: 'Music Player', w: 460, h: 420 },
  orchestration: { title: 'Orchestration', w: 520, h: 560 },
  chat: { title: 'AI Chat', w: 560, h: 560 },
}






/**
 * Upper bound on a widget's size, per kind. Kinds not listed have no cap.
 *
 * This lived as two copies of an if/else chain inside App.tsx's pointer and
 * keyboard resize handlers, and both applied it *after* deriving the widget's
 * new x/y from the unclamped size — so dragging the west or north edge of a
 * capped widget past its limit kept moving the anchored corner while the
 * size stood still, and the widget slid across the canvas. Callers must clamp
 * the size first and derive the position from the clamped result.
 */
const WIDGET_MAX_SIZE: Partial<Record<WidgetKind, { w: number; h: number }>> = {
  timer: { w: 360, h: 320 },
  links: { w: 560, h: 520 },
  files: { w: 760, h: 620 },
  'music-player': { w: 620, h: 580 },
  orchestration: { w: 760, h: 720 }
}

export function clampWidgetSize(
  kind: WidgetKind | string | undefined,
  w: number,
  h: number
): { w: number; h: number } {
  const max = WIDGET_MAX_SIZE[kind as WidgetKind]
  return {
    w: Math.min(Math.max(w, MIN_W), max?.w ?? Number.POSITIVE_INFINITY),
    h: Math.min(Math.max(h, MIN_H), max?.h ?? Number.POSITIVE_INFINITY)
  }
}

export function coerceWidgetSize(w: number, h: number, vw: number, vh: number): { w: number; h: number } {
  const maxW = Math.max(MIN_W, (vw || 0) - 32)
  const maxH = Math.max(MIN_H, (vh || 0) - 32)
  return {
    w: Math.min(Math.max(w, MIN_W), maxW),
    h: Math.min(Math.max(h, MIN_H), maxH)
  }
}


export const clampDefaultSize = coerceWidgetSize
