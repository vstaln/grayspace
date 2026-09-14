import type { Sheet } from './css'
import {
  darkTokens,
  frost,
  geometry,
  hairline,
  monochrome,
  palette,
  toCustomProperty,
  translucentTokens,
  typography,
  type ThemeTokens
} from './tokens'


function toCustomProperties(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(tokens)) {
    out[toCustomProperty(name as keyof ThemeTokens)] = value
  }
  return out
}






const tokenSheet: Sheet = {
  ':root': {
    '--tok-font-sans': typography.sans,
    '--tok-radius-panel': geometry.radiusPanel,
    '--tok-rail-width': geometry.railWidth,
    ...toCustomProperties(darkTokens)
  },
  ':root[data-translucent]': toCustomProperties(translucentTokens)
}



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
  'body.is-dragging iframe, body.is-dragging webview, body.is-dragging embed': {
    pointerEvents: 'none !important'
  },






  'input, textarea, [contenteditable="true"], [contenteditable=""], [data-selectable]': {
    WebkitUserSelect: 'text',
    userSelect: 'text',

    cursor: 'auto'
  },


  ':root': { colorScheme: 'dark' },

  '::-webkit-scrollbar': {
    width: '9px',
    height: '9px',
    background: 'transparent'
  },
  '::-webkit-scrollbar-thumb': {
    background: palette.scrollThumb,
    borderRadius: '6px',
    backgroundClip: 'padding-box',
    border: '2px solid transparent'
  },
  '::-webkit-scrollbar-thumb:hover': { background: palette.scrollThumbHover },
  '::-webkit-scrollbar-corner': { background: 'transparent' },

  'html[data-translucent], html[data-translucent] body, html[data-translucent] #root': {
    background: 'transparent'
  }
}






// Keep native controls inside the OrcSpace palette. This sheet is unlayered so
// it can override Uno's unlayered preflight while utility classes still win.
const controlSheet: Sheet = {
  'button, input, select, optgroup, textarea': { backgroundColor: 'transparent' },
  select: {
    appearance: 'none',
    WebkitAppearance: 'none',
    colorScheme: 'dark',
    backgroundColor: monochrome.surface,
    backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23A9A9B0%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 9px center',
    backgroundSize: '14px',
    paddingRight: '30px'
  },
  'select option, select optgroup': {
    color: palette.white,
    backgroundColor: monochrome.elevated,
    colorScheme: 'dark'
  },
  'select option:checked': { color: palette.white, backgroundColor: monochrome.raised },
  'select:disabled': { cursor: 'not-allowed', opacity: 0.4 },
  'input[type="checkbox"]': {
    appearance: 'none',
    WebkitAppearance: 'none',
    width: '16px',
    height: '16px',
    flex: 'none',
    display: 'inline-grid',
    placeItems: 'center',
    border: `1px solid ${monochrome.raised}`,
    borderRadius: '4px',
    backgroundColor: monochrome.surface,
    colorScheme: 'dark',
    cursor: 'pointer'
  },
  'input[type="checkbox"]::after': {
    content: "''",
    width: '8px',
    height: '5px',
    borderLeft: `2px solid ${monochrome.base}`,
    borderBottom: `2px solid ${monochrome.base}`,
    transform: 'rotate(-45deg) scale(0)',
    transition: 'transform 120ms ease'
  },
  'input[type="checkbox"]:checked': { borderColor: palette.white, backgroundColor: palette.white },
  'input[type="checkbox"]:checked::after': { transform: 'rotate(-45deg) scale(1)' },
  'input[type="checkbox"]:disabled': { cursor: 'not-allowed', opacity: 0.4 },
  'input[type="range"]': {
    appearance: 'none',
    WebkitAppearance: 'none',
    height: '16px',
    colorScheme: 'dark',
    accentColor: palette.white,
    background: 'transparent',
    cursor: 'pointer'
  },
  'input[type="range"]::-webkit-slider-runnable-track': {
    height: '4px', borderRadius: geometry.radiusPill, background: monochrome.raised
  },
  'input[type="range"]::-webkit-slider-thumb': {
    appearance: 'none',
    WebkitAppearance: 'none',
    width: '14px',
    height: '14px',
    marginTop: '-5px',
    border: `2px solid ${monochrome.raised}`,
    borderRadius: geometry.radiusPill,
    background: palette.white
  },
  'input[type="file"]': { color: darkTokens.colorTextDim },
  'input[type="file"]::file-selector-button': {
    minHeight: '36px',
    marginRight: '8px',
    padding: '6px 12px',
    border: `1px solid ${monochrome.raised}`,
    borderRadius: '8px',
    color: palette.white,
    background: monochrome.raised,
    cursor: 'pointer'
  }
}

const componentsLayer: Sheet = {

  '.title-bar-shell': {
    borderRadius: geometry.radiusBar,
    background: monochrome.surface,
    borderBottom: `1px solid ${monochrome.raised}`
  },

  '.title-bar-shell button, .title-bar-shell button *': {
    WebkitAppRegion: 'no-drag'
  },

  '.title-bar-shell .title-bar-view-tab': {
    borderRadius: `${geometry.radiusPill} !important`
  },

  '.title-bar-shell .title-bar-view-switch, .title-bar-shell .title-bar-git-switch': {
    height: '30px',
    gap: '0',
    padding: '3px',
    background: monochrome.base,
    border: `1px solid ${monochrome.surface}`,
    borderRadius: `${geometry.radiusPill} !important`
  },

  '.title-bar-shell .title-bar-view-switch .title-bar-view-tab, .title-bar-shell .title-bar-git-switch .title-bar-git': {
    height: '24px',
    paddingLeft: '11px',
    paddingRight: '11px',
    fontSize: '12px',
    background: monochrome.base,
    borderRadius: `${geometry.radiusPill} !important`
  },

  '.title-bar-shell .title-bar-view-switch .title-bar-view-tab + .title-bar-view-tab': {
    borderLeft: '0'
  },

  '.title-bar-shell .title-bar-view-switch .title-bar-view-tab[aria-selected="true"], .title-bar-shell .title-bar-git-switch .title-bar-git[aria-expanded="true"]': {
    background: monochrome.raised,
    border: '0',
    color: '#ffffff',
    fontWeight: 600,
    boxShadow: 'none'
  },

  '.rail-shell': {
    background: `${monochrome.surface} !important`,
    backgroundColor: `${monochrome.surface} !important`,
    boxShadow: `inset -1px 0 0 ${hairline.faint}`,



    'button, input, textarea, select, [role="button"]': {
      WebkitAppRegion: 'no-drag'
    },
    'html[data-translucent] &': {
      background: `${monochrome.surface} !important`,
      backgroundColor: `${monochrome.surface} !important`,
      backdropFilter: 'none !important',
      WebkitBackdropFilter: 'none !important'
    },
    '&.is-expanded': {
      background: `${monochrome.surface} !important`,
      backgroundColor: `${monochrome.surface} !important`,
      backdropFilter: 'none !important',
      WebkitBackdropFilter: 'none !important'
    }
  },


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


      backgroundColor: 'transparent',
      backdropFilter: frost.surface,
      WebkitBackdropFilter: frost.surface
    },


    "html[data-theme='photo'] &": {
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none'
    }
  },

  "html[data-theme='dark'] .canvas-area": {
    background: monochrome.base
  },

  








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


    inset: '-48px',
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat',
    pointerEvents: 'none',

    willChange: 'transform',
    transform: 'translate3d(0, 0, 0)',
    backfaceVisibility: 'hidden'
  },

  '.wallpaper-dim': {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none'
  },



  '.widget-shell': {
    background: monochrome.surface,
    boxShadow: `0 0 0 1px ${hairline.soft}`,
    backfaceVisibility: 'hidden',


    touchAction: 'pan-x pan-y',
    '&.is-active': { boxShadow: `0 0 0 1px ${hairline.active}` },



    '&.connect-target-active': { boxShadow: '0 0 0 2px rgba(169, 171, 176, 0.9)' },


    '&:focus-visible': {
      outline: 'none',
      boxShadow: `0 0 0 1px ${hairline.soft}, 0 0 0 3px ${hairline.active}`
    },
    'html[data-translucent] &': {
      background: 'rgba(18, 18, 18, 0.82)',
      backdropFilter: frost.shell,
      WebkitBackdropFilter: frost.shell,
      boxShadow: `0 0 0 1px ${hairline.glassSoft}`
    },
    'html[data-translucent] &.is-active': { boxShadow: `0 0 0 1px ${hairline.activeGlass}` },



    '&.is-terminal': { background: palette.terminalSolid },
    'html[data-translucent] &.is-terminal': {
      background: palette.terminalSolid,
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none'
    },
    '&.is-terminal.is-canvas-terminal': {
      background: palette.terminalGlass,
      backdropFilter: frost.terminal,
      WebkitBackdropFilter: frost.terminal,


      boxShadow: 'none'
    },
    '&.is-terminal.is-canvas-terminal.is-active': {


      boxShadow: '0 0 0 1px rgba(169, 171, 176, 0.42)'
    },
    'html[data-translucent] &.is-terminal.is-canvas-terminal': {
      background: palette.terminalGlass,
      backdropFilter: frost.terminal,
      WebkitBackdropFilter: frost.terminal,
      boxShadow: 'none'
    },
    'html[data-translucent] &.is-terminal.is-canvas-terminal.is-active': {
      boxShadow: '0 0 0 1px rgba(169, 171, 176, 0.48)'
    },


    '&.is-terminal .widget-header-shell': {
      background: 'rgba(18, 18, 18, 0.35)',
      backdropFilter: 'blur(60px)',
      WebkitBackdropFilter: 'blur(60px)',
      boxShadow: 'none'
    },
  },

  // Moving a terminal with a live backdrop-filter is one of the most
  // expensive paths on Windows when the driver is under load. During a
  // pointer drag the widget is already on its own compositor layer; suspend
  // the blur until the final position is committed, then restore the glass.
  'body.is-dragging .widget-shell': {
    willChange: 'transform',
    transition: 'none !important'
  },
  'body.is-dragging .widget-shell.is-canvas-terminal': {
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none'
  },

  '.widget-header-shell': {
    background: monochrome.surface,
    boxShadow: `inset 0 -1px 0 ${hairline.faint}`,
    'html[data-translucent] &': { background: 'rgba(18, 18, 18, 0.82)' },


    button: { position: 'relative' },
    'button::after': { content: "''", position: 'absolute', inset: '-3px', borderRadius: 'inherit' }
  },


  '@media (prefers-reduced-motion: reduce)': {
    '*, *::before, *::after': {
      animationDuration: '0.01ms !important',
      animationIterationCount: '1 !important',
      transitionDuration: '0.01ms !important',
      backdropFilter: 'none !important',
      WebkitBackdropFilter: 'none !important'
    },
    '.conn-flare-dot, .conn-idle-dot': { display: 'none' },
    'input[type="checkbox"]::after': { transition: 'none' }
  },








  '.pop-in': { animation: 'pop-in 200ms ease-out' },
  '@keyframes pop-in': {
    from: { opacity: 0, transform: 'scale(0.95)' },
    to: { opacity: 1, transform: 'scale(1)' }
  },


  '.browser-chrome': {
    background: monochrome.surface,
    borderBottom: `1px solid ${hairline.soft}`,
    contain: 'layout paint style'
  },
  '.browser-tab-strip': {
    background: monochrome.base,
    borderBottom: `1px solid ${hairline.soft}`,
    scrollbarWidth: 'none',
    '&::-webkit-scrollbar': { display: 'none' }
  },
  '.browser-tab': {
    position: 'relative',
    contain: 'layout paint',
    transition: 'background 120ms ease, color 120ms ease'
  },
  '.browser-tab-active': {
    background: monochrome.raised,
    color: palette.white,
    borderColor: 'transparent'
  },
  '.browser-tab-idle': {
    background: 'transparent',
    color: palette.white,
    '&:hover': { background: monochrome.raised, color: palette.white }
  },
  '.browser-omnibox': {
    background: monochrome.surface,
    border: `1px solid ${hairline.soft}`,
    transition: 'border-color 120ms ease, background 120ms ease',
    '&:focus-within': {
      background: monochrome.raised,
      borderColor: hairline.active
    }
  },
  '.browser-omnibox-input': {
    background: 'transparent',
    outline: 'none'
  },
  '.browser-icon-btn': {
    color: palette.white,
    transition: 'background 120ms ease, color 120ms ease',
    '&:hover': { background: monochrome.raised, color: palette.white },
    '&:active': { background: monochrome.raised },
    '&:disabled': { opacity: 0.3, pointerEvents: 'none' }
  },
  '.browser-surface': {
    background: monochrome.base,
    contain: 'strict'
  },


  '.load-bar': {
    background: monochrome.surface,
    willChange: 'transform',
    animation: 'load-bar-slide 1.0s ease-in-out infinite',
    contain: 'paint'
  },
  '.load-bar-track': {
    background: monochrome.surface,
    overflow: 'hidden',
    contain: 'paint'
  },
  '@keyframes load-bar-slide': {
    from: { transform: 'translateX(-100%)' },
    to: { transform: 'translateX(400%)' }
  },


  '.term-shell': {


    '& .xterm': { height: '100%' },

    '& .xterm, & .xterm-screen, & .xterm-viewport': {
      background: 'transparent !important',
      backgroundColor: 'transparent !important'
    },

    '&.is-code-term .xterm, &.is-code-term .xterm-screen, &.is-code-term .xterm-viewport, .code-terminal-shell & .xterm, .code-terminal-shell & .xterm-screen, .code-terminal-shell & .xterm-viewport': {
      background: '#080808 !important',
      backgroundColor: '#080808 !important'
    },


    '& .xterm-viewport::-webkit-scrollbar': { width: '0px' },
    '& .xterm-viewport': { scrollbarWidth: 'none' },
    '& .xterm-rows span': {
      display: 'inline-block !important',
      height: 'calc(100% + 1px) !important',
      verticalAlign: 'top !important'
    },
    '& .xterm-rows > div': {
      overflow: 'visible !important'
    },
    // Marked on the row <div>, which survives xterm rebuilding the row's
    // children — so a cursor span recreated mid-turn is hidden by this rule as
    // it is painted, instead of by a JS pass that always arrived a frame or
    // more too late. `!important` is what beats the background-color xterm
    // injects for `.xterm-focus .xterm-cursor.xterm-cursor-block`.
    '& [data-ghost-row] .xterm-cursor': {
      backgroundColor: 'transparent !important',
      outline: 'none !important',
      boxShadow: 'none !important',
      border: 'none !important',
      animation: 'none !important',
      opacity: '0 !important'
    }
  },



  '.code-terminal-shell': {
    background: '#080808',
    borderColor: monochrome.surface,
    '& .code-session-header': { background: monochrome.terminalHeader },
    '& .code-session-header:hover': { background: monochrome.raised }
  },






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
}









export const appStylesheet: Sheet = {
  ...tokenSheet,
  ...controlSheet,
  '@layer base': baseLayer,




  ':focus-visible': { outline: '1px solid rgba(169,171,176,0.38)', outlineOffset: '1px', borderRadius: '10px' },







  '@layer components': componentsLayer
}
