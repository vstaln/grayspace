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
 * The custom properties UnoCSS's theme reads. Both themes are emitted once and
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

/** Document-level defaults. Lives in a cascade layer, so utilities beat it —
 *  the same precedence the Tailwind preflight had before the UnoCSS switch. */
const baseLayer: Sheet = {
  '*': { boxSizing: 'border-box', margin: 0, padding: 0 },
  'html, body, #root': { height: '100%', overflow: 'hidden' },
  body: {
    fontFamily: 'var(--tok-font-sans)',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    color: 'var(--tok-color-text)',
    background: 'var(--tok-color-bg)'
  },
  // The blanket `user-select: none` above is what keeps a drag on the canvas
  // from painting a text selection across the whole shell — but it inherits
  // into real content too, and on macOS (where selecting and copying text is a
  // constant reflex) that reads as the app being broken. Hand selection back to
  // everything that actually holds text: fields, editable regions, and anything
  // opting in with `data-selectable`.
  'input, textarea, [contenteditable="true"], [contenteditable=""], [data-selectable]': {
    WebkitUserSelect: 'text',
    userSelect: 'text',
    // Chromium suppresses the OS selection colour under an inherited `none`.
    cursor: 'auto'
  },
  // Native controls (date pickers, scrollbars, autofill) follow the dark
  // theme instead of flashing the OS light defaults (AUD-09).
  ':root': { colorScheme: 'dark' },
  // One shared scrollbar look for every surface, matching the xterm viewport.
  '::-webkit-scrollbar': {
    width: '9px',
    height: '9px',
    background: 'transparent'
  },
  '::-webkit-scrollbar-thumb': {
    background: '#3a3f4a',
    borderRadius: '6px',
    backgroundClip: 'padding-box',
    border: '2px solid transparent'
  },
  '::-webkit-scrollbar-thumb:hover': { background: '#4a5160' },
  '::-webkit-scrollbar-corner': { background: 'transparent' },
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
      background: 'var(--tok-color-accent-soft)',
      borderColor: hairline.railActiveGlassBorder,
      color: palette.white,
      boxShadow: 'none'
    }
  },

  '.desktop-surface': {
    background: 'var(--tok-color-bg)',
    'html[data-translucent] &': {
      backgroundImage: 'none',
      // Blur alone, no black veil — the frosted blur keeps the canvas legible
      // without washing out what's showing through it.
      backgroundColor: 'transparent',
      backdropFilter: frost.surface,
      WebkitBackdropFilter: frost.surface
    },
    // The photo theme is the one translucent theme, and it has something worth
    // looking at behind the canvas, so it drops the generic frosting above.
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
  '.wallpaper-container': {
    position: 'fixed',
    inset: 0,
    zIndex: -1,
    overflow: 'hidden',
    pointerEvents: 'none',
    backgroundColor: palette.wallpaperBase,
    contain: 'strict'
  },

  '.wallpaper-image': {
    position: 'absolute',
    // Extend beyond container edges by 48px to eliminate edge-blur fade
    // without needing CSS scale() transforms that cause Skia tile artifacts.
    inset: '-48px',
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat',
    pointerEvents: 'none',
    // Force a stable, dedicated compositor layer with integer pixel boundaries
    willChange: 'transform',
    transform: 'translate3d(0, 0, 0)',
    backfaceVisibility: 'hidden'
  },

  '.wallpaper-dim': {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none'
  },

  // Flat fill + a hairline ring; depth comes from the ring alone, so a focused
  // widget reads as "in front" without a glossy top highlight.
  '.widget-shell': {
    background: palette.graphite,
    boxShadow: `0 0 0 1px ${hairline.soft}`,
    // main has touch-action:none so canvas gestures own the touch stream;
    // widget bodies still need native touch scroll inside their own bounds.
    touchAction: 'pan-x pan-y',
    '&.is-active': { boxShadow: `0 0 0 1px ${hairline.active}` },
    // A terminal the cursor is dragging a Check widget's wire over — the same
    // bluish-white the wire itself glows, so the highlighted target reads as
    // "this is what the thread would land on" (CANV connect-drag).
    '&.connect-target-active': { boxShadow: '0 0 0 2px rgba(223, 231, 255, 0.9)' },
    // Keyboard focus (Tab onto the frame) gets a visible ring so the user can
    // tell whether arrows will move the widget or pan the canvas (CANV-14).
    '&:focus-visible': {
      outline: 'none',
      boxShadow: `0 0 0 1px ${hairline.soft}, 0 0 0 3px ${hairline.active}`
    },
    'html[data-translucent] &': {
      background: palette.graphite,
      backdropFilter: frost.shell,
      WebkitBackdropFilter: frost.shell,
      boxShadow: `0 0 0 1px ${hairline.glassSoft}`
    },
    'html[data-translucent] &.is-active': { boxShadow: `0 0 0 1px ${hairline.activeGlass}` },
    // A terminal is a text surface, not a window onto the wallpaper: it keeps
    // one opaque fill in every theme. The explicit translucent-theme rule is
    // required to out-rank `html[data-translucent] .widget-shell` above.
    '&.is-terminal': { background: palette.terminalSolid },
    'html[data-translucent] &.is-terminal': {
      background: palette.terminalSolid,
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none'
    },
    // One flat slab: the header drops its own graphite coat and its underline
    // hairline, so frame, header and terminal body are a single tone.
    '&.is-terminal .widget-header-shell': { background: 'transparent', boxShadow: 'none' }
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

  // P3-221: honour the OS-level reduced-motion preference.
  '@media (prefers-reduced-motion: reduce)': {
    '*, *::before, *::after': {
      animationDuration: '0.01ms !important',
      animationIterationCount: '1 !important',
      transitionDuration: '0.01ms !important'
    },
    '.conn-flare-dot, .conn-idle-dot': { display: 'none' }
  },

  /*
   * Entrance for modal surfaces (Task Board, file preview): a quiet fade plus
   * a 95%-scale settle. Replaces the `animate-in fade-in zoom-in-95` classes
   * from tailwindcss-animate — that plugin is not installed, so those class
   * names never generated any CSS and the panels simply popped in with no
   * transition at all.
   */
  '.pop-in': { animation: 'pop-in 200ms ease-out' },
  '@keyframes pop-in': {
    from: { opacity: 0, transform: 'scale(0.95)' },
    to: { opacity: 1, transform: 'scale(1)' }
  },

  /* Browser — простой тёмно-серый, без стекла и без белых обводок */
  '.browser-chrome': {
    background: '#1e1e21',
    borderBottom: '1px solid #2a2a2e',
    contain: 'layout paint style'
  },
  '.browser-tab-strip': {
    background: '#18181b',
    borderBottom: '1px solid #232326',
    scrollbarWidth: 'none',
    '&::-webkit-scrollbar': { display: 'none' }
  },
  '.browser-tab': {
    position: 'relative',
    contain: 'layout paint',
    transition: 'background 120ms ease, color 120ms ease'
  },
  '.browser-tab-active': {
    background: '#2a2a2e',
    color: '#ececec',
    borderColor: 'transparent'
  },
  '.browser-tab-idle': {
    background: 'transparent',
    color: '#8a8a90',
    '&:hover': { background: '#232326', color: '#d4d4d8' }
  },
  '.browser-omnibox': {
    background: '#252529',
    border: '1px solid #2e2e32',
    transition: 'border-color 120ms ease, background 120ms ease',
    '&:focus-within': {
      background: '#2a2a2e',
      borderColor: '#3a3a40'
    }
  },
  '.browser-omnibox-input': {
    background: 'transparent',
    outline: 'none'
  },
  '.browser-icon-btn': {
    color: '#9a9aa0',
    transition: 'background 120ms ease, color 120ms ease',
    '&:hover': { background: '#2a2a2e', color: '#ececec' },
    '&:active': { background: '#303034' },
    '&:disabled': { opacity: 0.3, pointerEvents: 'none' }
  },
  '.browser-surface': {
    background: '#121214',
    contain: 'strict'
  },

  /* Тонкая полоса загрузки — просто серая, без белых свечений */
  '.load-bar': {
    background: '#5a5a60',
    willChange: 'transform',
    animation: 'load-bar-slide 1.0s ease-in-out infinite',
    contain: 'paint'
  },
  '.load-bar-track': {
    background: '#1e1e21',
    overflow: 'hidden',
    contain: 'paint'
  },
  '@keyframes load-bar-slide': {
    from: { transform: 'translateX(-100%)' },
    to: { transform: 'translateX(400%)' }
  },


  '.term-shell': {
    // The terminal's frame (.widget-shell.is-terminal) is fully opaque in every
    // theme, so this wrapper stays clear — no fill and no frosting of its own;
    // the wallpaper can no longer show through the body.
    '& .xterm': { height: '100%' },
    // xterm paints its own background on a canvas CSS can't reach — see
    // TerminalWidget.tsx's xtermTheme, which uses the frame's exact
    // `terminalSolid`. These wrapper divs just stay out of the way.
    '& .xterm, & .xterm-screen, & .xterm-viewport': { background: 'transparent !important' },
    // Scrolling stays fully functional (wheel/trackpad) — only the visible
    // scrollbar track/thumb is hidden, so nothing overlaps the terminal text.
    '& .xterm-viewport::-webkit-scrollbar': { width: '0px' },
    '& .xterm-viewport': { scrollbarWidth: 'none' }
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
 * The whole app stylesheet. The `@layer base` block keeps document defaults in
 * a real cascade layer, so the (unlayered) UnoCSS utilities still win over
 * them, while unlayered app rules win over everything.
 *
 * `:focus-visible` is deliberately left unlayered: it has to beat Uno's
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
  // Text fields already show focus themselves — every styled input/textarea in
  // the app switches its own border color on focus — so the generic ring on
  // top of that just doubled the outline into a floating oval around the
  // control. Higher specificity than the bare `:focus-visible` above, so this
  // wins without needing `!important`. Buttons and other controls with no
  // self-drawn focus state keep the ring.
  ':is(input, textarea):focus-visible': { outline: 'none' },
  '@layer components': componentsLayer
}
