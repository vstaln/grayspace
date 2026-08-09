export interface Widget {
  id: string
  title: string
  kind?: 'terminal' | 'note'
  noteId?: string
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized?: boolean
  maximized?: boolean
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
export const HEADER_H = 0
