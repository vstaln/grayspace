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
      // A 45% black veil made vivid wallpapers look nearly monochrome. Keep
      // the user's dim setting, but apply it more gently so the canvas remains
      // readable without washing the image's colour out.
      opacity: 'calc(var(--wallpaper-dim, 0.45) * 0.68)'
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
    '.thinking-dot': { animation: 'none' },
    '.conn-flare-dot, .conn-idle-dot': { display: 'none' }
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

  // The lit cable between an agent's terminal and the one it opened. A thin
  // steady thread carries the "this connects to that" fact permanently; the
  // wide blurred pass on top is what actually reads as glow. Fresh links
  // simply run brighter/wider for their flare window — the shape is identical
  // either way, so nothing jumps when it settles.
  '.conn-thread': {
    stroke: 'rgba(223, 231, 255, 0.34)',
    strokeWidth: 1,
    vectorEffect: 'non-scaling-stroke'
  },
  '.conn-glow': {
    stroke: 'rgba(223, 231, 255, 0.5)',
    strokeWidth: 2.4,
    vectorEffect: 'non-scaling-stroke',
    transition: 'stroke-width 0.4s ease, stroke-opacity 0.4s ease'
  },
  '.conn-arc-fresh .conn-glow': {
    stroke: 'rgba(255, 255, 255, 0.85)',
    strokeWidth: 3.4
  },
  '.conn-arc-fresh .conn-thread': {
    stroke: 'rgba(255, 255, 255, 0.55)'
  },
  '.conn-flare-dot': {
    filter: 'drop-shadow(0 0 4px rgba(255,255,255,0.95)) drop-shadow(0 0 9px rgba(180,200,255,0.8))'
  },
  '.conn-idle-dot': {
    filter: 'drop-shadow(0 0 3px rgba(200,215,255,0.75))'
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
  // A hairline, not a slab. The old ring was 2px of solid white at a 2px
  // offset, which around a rounded input drew a hard rectangle floating off
  // the control — it read as unstyled browser chrome. Keyboard users still get
  // a clear ring; it just belongs to this app now.
  ':focus-visible': { outline: '1px solid rgba(255,255,255,0.38)', outlineOffset: '1px', borderRadius: '10px' },
  // Text surfaces that already show focus themselves get no ring at all: the
  // note's body border lightens, the chat composer's card border lifts, and a
  // second ring on top of that is noise. Higher specificity than the bare
  // `:focus-visible` above, so these win without needing `!important`.
  '.composer-shell textarea:focus-visible': { outline: 'none' },
  '.note-surface :is(input, textarea):focus-visible': { outline: 'none' },
  '@layer components': componentsLayer
}
