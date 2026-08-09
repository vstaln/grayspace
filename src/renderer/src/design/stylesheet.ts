import type { Sheet } from './css'
import {
  darkTokens,
  frost,
  geometry,
  hairline,
  lanes,
  palette,
  toCustomProperty,
  translucentTokens,
  typography,
  type ThemeTokens
} from './tokens'

/** `{ colorBg: '#000' }` → `{ '--tok-color-bg': '#000' }`. */
function toCustomProperties(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(tokens)) {
    out[toCustomProperty(name as keyof ThemeTokens)] = value
  }
  return out
}

/**
 * The custom properties Tailwind's theme reads. Both themes are emitted once and
 * swapped by the `data-translucent` attribute the ThemeProvider sets, so
 * switching themes stays a single attribute write with no restyle pass in JS.
 */
const tokenSheet: Sheet = {
  ':root': {
    '--tok-font-sans': typography.sans,
    '--tok-radius-panel': geometry.radiusPanel,
    '--tok-rail-width': geometry.railWidth,
    ...toCustomProperties(darkTokens)
  },
  ':root[data-translucent]': toCustomProperties(translucentTokens)
}

/** Resets and document-level defaults. Lowest precedence, as in Tailwind. */
const baseLayer: Sheet = {
  '*': { boxSizing: 'border-box', margin: 0, padding: 0 },
  'html, body, #root': { height: '100%', overflow: 'hidden' },
  body: {
    fontFamily: 'var(--font-sans)',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    color: 'var(--color-text)',
    background: 'var(--color-bg)'
  },
  // A translucent theme lets the desktop show through the window itself.
  'html[data-translucent], html[data-translucent] body, html[data-translucent] #root': {
    background: 'transparent'
  }
}

/**
 * Decorative treatments that utility classes do not express well: frosted
 * shells, canvas backdrops, keyframes. Everything else is styled with utility
 * classes in the JSX.
 */
const componentsLayer: Sheet = {
  // Edges are drawn with inset shadows rather than real borders throughout: a
  // border would add to the box and shift layouts already sized in the JSX.
  '.rail-shell': {
    background: palette.graphite,
    boxShadow: `inset -1px 0 0 ${hairline.faint}`,
    'html[data-translucent] &': {
      background: palette.graphite,
      backdropFilter: frost.shell,
      WebkitBackdropFilter: frost.shell
    }
  },

  // Active state is a quiet lift out of the background, not a white slab.
  '.rail-btn-active': {
    borderColor: hairline.railActiveBorder,
    background: hairline.railActiveFill,
    color: palette.white,
    boxShadow: 'none',
    'html[data-translucent] &': {
      background: 'var(--color-accent-soft)',
      borderColor: hairline.railActiveGlassBorder,
      color: palette.white,
      boxShadow: 'none'
    }
  },

  '.desktop-surface': {
    background: 'var(--color-bg)',
    'html[data-translucent] &': {
      backgroundImage: 'none',
      backgroundColor: 'rgba(10, 10, 12, 0.5)',
      backdropFilter: frost.surface,
      WebkitBackdropFilter: frost.surface
    },
    // The photo theme is the one translucent theme with something worth looking
    // at behind the canvas, so it drops the frosting the glass theme applies.
    "html[data-theme='photo'] &": {
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none'
    }
  },

  /*
   * The wallpaper sits behind the whole window — title bar and rail included —
   * rather than inside the canvas, so panning the canvas doesn't move it. The
   * solid base colour is the photo theme's fallback when no picture is set:
   * without it the window would be fully transparent (frame:false + transparent
   * window), showing the bare desktop behind the UI (P2-207).
   */
  '.wallpaper-layer': {
    position: 'fixed',
    inset: 0,
    zIndex: -1,
    backgroundColor: palette.wallpaperBase,
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat',
    pointerEvents: 'none',
    // Dim is a separate layer so changing it never re-decodes the image.
    '&::after': {
      content: "''",
      position: 'absolute',
      inset: 0,
      background: '#000000',
      opacity: 'var(--wallpaper-dim, 0.45)'
    }
  },

  // Flat fill + a hairline ring; depth comes from the ring alone, so a focused
  // widget reads as "in front" without a glossy top highlight.
  '.widget-shell': {
    background: palette.graphite,
    boxShadow: `0 0 0 1px ${hairline.soft}`,
    '&.is-active': { boxShadow: `0 0 0 1px ${hairline.active}` },
    'html[data-translucent] &': {
      background: palette.graphite,
      backdropFilter: frost.shell,
      WebkitBackdropFilter: frost.shell,
      boxShadow: `0 0 0 1px ${hairline.glassSoft}`
    },
    'html[data-translucent] &.is-active': { boxShadow: `0 0 0 1px ${hairline.activeGlass}` }
  },

  '.widget-header-shell': {
    background: palette.graphite,
    boxShadow: `inset 0 -1px 0 ${hairline.faint}`,
    'html[data-translucent] &': { background: palette.graphite },
    // P3-212: the 19px header buttons get a larger hit area (19 + 3 + 3 = 25px)
    // via a pseudo-element overlay, keeping their visual size.
    button: { position: 'relative' },
    'button::after': { content: "''", position: 'absolute', inset: '-3px', borderRadius: 'inherit' }
  },

  '.chat-fab-shell': {
    background: palette.offWhite,
    '&:hover': { background: palette.white },
    'html[data-translucent] &': { background: palette.offWhite }
  },

  // Frosted at every theme, not just glass/photo: the panel docks to the full
  // window height and reads better with the canvas showing faintly through.
  '.chat-panel-shell': {
    background: palette.graphite,
    backdropFilter: frost.chat,
    WebkitBackdropFilter: frost.chat,
    boxShadow: `-1px 0 0 ${hairline.soft}`,
    'html[data-translucent] &': {
      background: palette.graphite,
      backdropFilter: frost.board,
      WebkitBackdropFilter: frost.board
    }
  },

  // The composer sits inside the already-frosted chat panel, so it only needs a
  // faint lift to read as a raised card — a second dark fill would stack toward
  // opaque and lose the wallpaper showing through.
  '.composer-shell': { background: palette.surfaceLift },

  '.thinking-dot': {
    animation: 'blink 0.9s infinite alternate',
    '&:nth-child(2)': { animationDelay: '0.2s' },
    '&:nth-child(3)': { animationDelay: '0.4s' }
  },
  '@keyframes blink': { to: { opacity: 0.2, transform: 'translateY(-2px)' } },

  // P3-221: honour the OS-level reduced-motion preference.
  '@media (prefers-reduced-motion: reduce)': {
    '*, *::before, *::after': {
      animationDuration: '0.01ms !important',
      animationIterationCount: '1 !important',
      transitionDuration: '0.01ms !important'
    },
    '.thinking-dot': { animation: 'none' }
  },

  '.brain-graph-surface': { background: 'var(--color-bg)' },

  '.term-shell': {
    background: palette.terminalGlass,
    '& .xterm': { height: '100%' },
    // xterm paints its own background on a canvas that CSS can't reach — see
    // TerminalWidget.tsx's xtermTheme, kept in sync with `terminalGlass`. These
    // wrapper divs just stay out of the way so the shell's fill shows through.
    '& .xterm, & .xterm-screen, & .xterm-viewport': { background: 'transparent !important' },
    '& .xterm-viewport::-webkit-scrollbar': { width: '10px' },
    '& .xterm-viewport::-webkit-scrollbar-track': { background: 'transparent' },
    '& .xterm-viewport::-webkit-scrollbar-thumb': {
      border: '3px solid transparent',
      borderRadius: '6px',
      background: palette.scrollThumb,
      backgroundClip: 'padding-box'
    },
    '& .xterm-viewport::-webkit-scrollbar-thumb:hover': {
      background: palette.scrollThumbHover,
      backgroundClip: 'padding-box'
    }
  },

  // Kanban lanes keep a faint colour identity per status — a low-alpha tint over
  // the flat fill rather than a gradient, so they stay legible without glowing.
  '.lane-blue': { background: lanes.blue.fill, borderColor: lanes.blue.border },
  '.lane-amber': { background: lanes.amber.fill, borderColor: lanes.amber.border },
  '.lane-green': { background: lanes.green.fill, borderColor: lanes.green.border },
  '.lane-red': { background: lanes.red.fill, borderColor: lanes.red.border },
  '.lane-dot-blue': { background: lanes.blue.dot },
  '.lane-dot-amber': { background: lanes.amber.dot },
  '.lane-dot-green': { background: lanes.green.dot },
  '.lane-dot-red': { background: lanes.red.dot },

  '.board-shell': {
    background: palette.graphite,
    boxShadow: `0 0 0 1px ${hairline.soft}`,
    'html[data-translucent] &': {
      background: palette.graphite,
      backdropFilter: frost.board,
      WebkitBackdropFilter: frost.board
    }
  }
}

/**
 * The whole app stylesheet. Layer names are the ones Tailwind already declares,
 * so these rules keep exactly the precedence they had as hand-written CSS —
 * utilities still win over components, and components over base.
 *
 * `:focus-visible` is deliberately left unlayered: it has to beat Tailwind's
 * `outline-none` utility (P3-215).
 */
export const appStylesheet: Sheet = {
  ...tokenSheet,
  '@layer base': baseLayer,
  ':focus-visible': { outline: '2px solid var(--color-accent)', outlineOffset: '2px' },
  // The composer's textarea already shows focus via the card's own border
  // turning from `line` to `text-faint` (see `.composer-shell` in ChatPanel) —
  // a second, blunt browser-style ring on top of that reads as unstyled chrome
  // rather than as this app's own UI. Higher specificity than the bare
  // `:focus-visible` above, so it wins without needing `!important`.
  '.composer-shell textarea:focus-visible': { outline: 'none' },
  '@layer components': componentsLayer
}
