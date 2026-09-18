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

/** Rows used by the dense layouts, and how many cards go in each. */
export function denseRowCounts(count: number): number[] {
  const rows = count <= 8 || count === 10 ? 2 : count <= 15 ? 3 : 4
  if (count === 9) return [3, 3, 3]
  const perRow = Math.floor(count / rows)
  const remainder = count % rows
  return Array.from({ length: rows }, (_, row) => perRow + (row < remainder ? 1 : 0))
}

/**
 * Column count the dense layouts place cards against.
 *
 * 60 rather than the number of cards in a row, because rows do not all hold
 * the same number: a row of four spans 15 columns per card and a row of three
 * spans 20, and both have to line up on the same grid. 60 is the smallest
 * number every row size these layouts produce (3, 4 and 5) divides exactly —
 * a fractional span would leave a seam down the grid.
 */
const DENSE_COLUMNS = 60

/** The row template `auto` uses everywhere it is not placing rows explicitly. */
const AUTO_ROWS = `minmax(${MIN_CARD_H}px, 1fr)`

/** Ratios of the draggable 3-way split, as percentages of the container. */
export interface ThreeWaySplit {
  col: number
  row: number
}

/**
 * The `auto` layout: a hand-tuned shape per session count.
 *
 * This lived inside the Code view, spread across a nested ternary for the
 * column count, a `placementForIndex` helper and an inline container style —
 * while the explicit modes above sat here, in one testable piece. Two layout
 * systems of the same shape in two places is how they drift, and the ternary
 * had already grown two arms that could never run: `count <= 6` and
 * `count === 10` both sit inside the 6–20 range handled before them.
 */
export function autoCodeLayout(count: number, split: ThreeWaySplit): CodeGridLayout {
  if (count === 3) {
    // The only layout whose tracks the user can drag; the 2px tracks are the
    // separators themselves, which is why rows and columns are both explicit.
    return {
      container: {
        gridTemplateColumns: `minmax(0, ${split.col}fr) 2px minmax(0, ${100 - split.col}fr)`,
        gridTemplateRows: `minmax(0, ${split.row}fr) 2px minmax(0, ${100 - split.row}fr)`
      },
      placement: (index) =>
        index === 0
          ? { gridColumn: '1', gridRow: '1 / 4' }
          : { gridColumn: '3', gridRow: index === 1 ? '1' : '3' }
    }
  }

  if (count === 5) {
    return {
      container: { gridTemplateColumns: '3fr 3fr 4fr', gridAutoRows: AUTO_ROWS },
      placement: (index) =>
        index < 4
          ? { gridColumn: `${(index % 2) + 1}`, gridRow: `${Math.floor(index / 2) + 1}` }
          : { gridColumn: '3', gridRow: '1 / span 2' }
    }
  }

  if (count >= 6 && count <= 20) {
    const rows = denseRowCounts(count)
    return {
      container: {
        gridTemplateColumns: `repeat(${DENSE_COLUMNS}, minmax(0, 1fr))`,
        gridAutoRows: AUTO_ROWS
      },
      placement: (index) => {
        let rowStart = 0
        for (const [row, inRow] of rows.entries()) {
          if (index < rowStart + inRow) {
            const span = DENSE_COLUMNS / inRow
            return { gridColumn: `${(index - rowStart) * span + 1} / span ${span}`, gridRow: `${row + 1}` }
          }
          rowStart += inRow
        }
        return {}
      }
    }
  }

  const columns = count <= 1 ? 1 : count <= 4 ? 2 : 4
  return {
    container: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: AUTO_ROWS },
    placement: AUTO_PLACEMENT
  }
}
