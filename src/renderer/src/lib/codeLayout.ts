/**
 * How the Code view arranges its session cards.
 *
 * `auto` is the hand-tuned layout the view has always had — a different shape
 * for every session count, including the 3-way split with its draggable
 * separators. The other modes are uniform overrides the user picks from the
 * title bar, and they own the whole grid while active.
 */
export type CodeLayoutMode = 'auto' | 'grid' | 'columns' | 'rows' | 'focus'

export const CODE_LAYOUT_MODES: readonly CodeLayoutMode[] = ['auto', 'grid', 'columns', 'rows', 'focus']

export function isCodeLayoutMode(value: unknown): value is CodeLayoutMode {
  return typeof value === 'string' && (CODE_LAYOUT_MODES as readonly string[]).includes(value)
}

/** Below this a terminal is unreadable, so the grid scrolls instead. */
const MIN_CARD_W = 280
const MIN_CARD_H = 180

export interface CodeGridLayout {
  /** Style for the grid container. */
  container: {
    gridTemplateColumns: string
    gridTemplateRows?: string
    gridAutoRows?: string
  }
  /** Placement for the card at `index`; `{}` leaves it to grid auto-placement. */
  placement(index: number): { gridColumn?: string; gridRow?: string }
}

const AUTO_PLACEMENT = (): Record<string, never> => ({})

/**
 * The grid for an explicit layout mode, or `null` for `auto` — the caller
 * keeps its own per-count layout in that case.
 *
 * `focusIndex` is the card that `focus` blows up; anything out of range falls
 * back to the first card.
 */
export function codeGridLayout(
  mode: CodeLayoutMode,
  count: number,
  focusIndex = 0
): CodeGridLayout | null {
  if (mode === 'auto' || count <= 0) return null

  if (count === 1) {
    return {
      container: { gridTemplateColumns: 'minmax(0, 1fr)', gridAutoRows: 'minmax(0, 1fr)' },
      placement: AUTO_PLACEMENT
    }
  }

  if (mode === 'columns') {
    return {
      container: {
        gridTemplateColumns: `repeat(${count}, minmax(${MIN_CARD_W}px, 1fr))`,
        gridAutoRows: 'minmax(0, 1fr)'
      },
      placement: AUTO_PLACEMENT
    }
  }

  if (mode === 'rows') {
    return {
      container: {
        gridTemplateColumns: 'minmax(0, 1fr)',
        gridAutoRows: `minmax(${MIN_CARD_H}px, 1fr)`
      },
      placement: AUTO_PLACEMENT
    }
  }

  if (mode === 'focus') {
    const side = count - 1
    const main = focusIndex >= 0 && focusIndex < count ? focusIndex : 0
    return {
      container: {
        gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
        gridTemplateRows: `repeat(${side}, minmax(${MIN_CARD_H}px, 1fr))`
      },
      placement: (index) => {
        if (index === main) return { gridColumn: '1', gridRow: `1 / span ${side}` }
        const slot = index < main ? index : index - 1
        return { gridColumn: '2', gridRow: `${slot + 1}` }
      }
    }
  }

  const columns = Math.ceil(Math.sqrt(count))
  return {
    container: {
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gridAutoRows: `minmax(${MIN_CARD_H}px, 1fr)`
    },
    placement: AUTO_PLACEMENT
  }
}
