import { clampWidgetSize, MIN_H, MIN_W, WIDGET_DEFAULTS, type Widget, type WidgetKind } from '../types.ts'

/**
 * How the canvas arranges its widgets. `free` is the untouched, hand-dragged
 * canvas: it restores the snapshot taken before the first arrange, so it is
 * handled by the caller rather than by a layout function.
 */
export type ArrangeMode = 'free' | 'grid' | 'tiny' | 'focus'

export const ARRANGE_MODES: readonly ArrangeMode[] = ['free', 'grid', 'tiny', 'focus']

export function isArrangeMode(value: unknown): value is ArrangeMode {
  return typeof value === 'string' && (ARRANGE_MODES as readonly string[]).includes(value)
}

/** The visible canvas area, in world coordinates. */
export interface LayoutViewport {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export const LAYOUT_GAP = 16

/**
 * Screen bands a fresh widget must not open under, in px: the floating title
 * bar on top and the bottom toolbar. Mirrors TITLE_BAR_HEIGHT (40) and
 * TOOLBAR_RESERVE_PX (88) in App.tsx plus breathing room.
 */
export const SPAWN_CHROME_RESERVE_PX = 192
/** Side breathing room for a fresh widget, in px. */
export const SPAWN_SIDE_MARGIN_PX = 64

/** Tile size Tiny aims for; clampWidgetSize still applies each widget's floor. */
const TINY_W = 300
const TINY_H = 200

/** Share of the width the focused widget takes in `focus`. */
const FOCUS_MAIN_RATIO = 0.7

type Placeable = Pick<Widget, 'id' | 'kind' | 'z'>

/**
 * Reading order for a layout: bottom of the z-stack first, so a re-arrange
 * keeps widgets roughly where the user last saw them relative to each other.
 */
function inStackOrder<T extends Placeable>(widgets: readonly T[]): T[] {
  return widgets.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
}

function tile(widget: Placeable, x: number, y: number, w: number, h: number): LayoutRect {
  const size = clampWidgetSize(widget.kind, w, h)
  return { id: widget.id, x: Math.round(x), y: Math.round(y), w: Math.round(size.w), h: Math.round(size.h) }
}

function gridOf(
  widgets: readonly Placeable[],
  viewport: LayoutViewport,
  columns: number,
  cellW: number,
  cellH: number
): LayoutRect[] {
  return widgets.map((widget, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    return tile(
      widget,
      viewport.x + LAYOUT_GAP + col * (cellW + LAYOUT_GAP),
      viewport.y + LAYOUT_GAP + row * (cellH + LAYOUT_GAP),
      cellW,
      cellH
    )
  })
}

/**
 * Spawn size for a widget kind that fits inside the visible area.
 *
 * `screenW`/`screenH` are viewport pixels and `zoom` is the canvas zoom; the
 * result is world units. On roomy viewports this is exactly the kind
 * default; on small windows the widget opens shrunk to the viewport instead
 * of cropped, and only grows when the user stretches it. Floored at the
 * widget minimums, so a viewport tinier than those still spawns the minimum
 * — same as before, no worse.
 */
export function fitSpawnSize(
  kind: WidgetKind | string | undefined,
  screenW: number,
  screenH: number,
  zoom: number
): { w: number; h: number } {
  const z = zoom || 1
  const availW = (screenW - SPAWN_SIDE_MARGIN_PX) / z
  const availH = (screenH - SPAWN_CHROME_RESERVE_PX) / z
  const defaults = WIDGET_DEFAULTS[kind as WidgetKind] ?? WIDGET_DEFAULTS.terminal
  return {
    w: Math.max(MIN_W, Math.min(defaults.w, Math.floor(availW))),
    h: Math.max(MIN_H, Math.min(defaults.h, Math.floor(availH)))
  }
}

/**
 * Positions every widget for `mode` inside `viewport`. Modes that cannot fit
 * their tiles in the visible area keep flowing downwards — the canvas is
 * infinite, and shrinking below a widget's minimum size is not an option.
 *
 * `focusId` names the widget `focus` blows up; without it the topmost widget
 * of the z-stack is used.
 */
export function arrangeWidgets(
  widgets: readonly Widget[],
  viewport: LayoutViewport,
  mode: Exclude<ArrangeMode, 'free'>,
  focusId?: string
): LayoutRect[] {
  if (widgets.length === 0 || viewport.w <= 0 || viewport.h <= 0) return []
  const ordered = inStackOrder(widgets)

  if (mode === 'tiny') {
    const columns = Math.max(1, Math.floor((viewport.w - LAYOUT_GAP) / (TINY_W + LAYOUT_GAP)))
    return gridOf(ordered, viewport, columns, TINY_W, TINY_H)
  }

  if (mode === 'focus') {
    const main = ordered.find((w) => w.id === focusId) ?? ordered[ordered.length - 1]
    const rest = ordered.filter((w) => w.id !== main.id)
    const innerW = viewport.w - LAYOUT_GAP * 2
    const innerH = viewport.h - LAYOUT_GAP * 2
    if (rest.length === 0) return [tile(main, viewport.x + LAYOUT_GAP, viewport.y + LAYOUT_GAP, innerW, innerH)]

    const mainW = Math.round((innerW - LAYOUT_GAP) * FOCUS_MAIN_RATIO)
    const sideW = innerW - LAYOUT_GAP - mainW
    const sideH = Math.max(
      TINY_H,
      Math.floor((innerH - LAYOUT_GAP * (rest.length - 1)) / rest.length)
    )
    const sideX = viewport.x + LAYOUT_GAP + mainW + LAYOUT_GAP
    return [
      tile(main, viewport.x + LAYOUT_GAP, viewport.y + LAYOUT_GAP, mainW, innerH),
      ...rest.map((widget, index) =>
        tile(widget, sideX, viewport.y + LAYOUT_GAP + index * (sideH + LAYOUT_GAP), sideW, sideH)
      )
    ]
  }

  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)))
  const rows = Math.ceil(ordered.length / columns)
  // A viewport too small for the grid still has to yield a readable layout:
  // the cell drives the row/column offsets, so letting it fall under the
  // widget minimum (or below zero) would stack tiles on top of each other.
  const cellW = Math.max(MIN_W, Math.floor((viewport.w - LAYOUT_GAP * (columns + 1)) / columns))
  const cellH = Math.max(MIN_H, Math.floor((viewport.h - LAYOUT_GAP * (rows + 1)) / rows))
  return gridOf(ordered, viewport, columns, cellW, cellH)
}
