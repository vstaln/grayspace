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






const componentsLayer: Sheet = {

  '.title-bar-shell': {
    borderRadius: geometry.radiusBar,
    background: monochrome.surface,
    borderBottom: `1px solid ${monochrome.raised}`
  },

  '.title-bar-shell .title-bar-view-tab': {
    borderRadius: `${geometry.radiusPill} !important`
  },

  '.title-bar-shell .title-bar-view-switch, .title-bar-shell .title-bar-git-switch, .title-bar-shell .title-bar-left-switch': {
    height: '30px',
    gap: '0',
    padding: '3px',
    background: monochrome.base,
    border: `1px solid ${monochrome.surface}`,
    borderRadius: `${geometry.radiusPill} !important`
  },

  '.title-bar-shell .title-bar-view-switch .title-bar-view-tab, .title-bar-shell .title-bar-git-switch .title-bar-git, .title-bar-shell .title-bar-left-switch .title-bar-left-btn': {
    height: '24px',
    paddingLeft: '11px',
    paddingRight: '11px',
    fontSize: '12px',
    background: monochrome.base,
    borderRadius: `${geometry.radiusPill} !important`
  },

  '.title-bar-shell .title-bar-left-switch .title-bar-left-btn': {
    paddingLeft: '8px',
    paddingRight: '8px'
  },

  '.title-bar-shell .title-bar-view-switch .title-bar-view-tab + .title-bar-view-tab': {
    borderLeft: '0'
  },

  '.title-bar-shell .title-bar-view-switch .title-bar-view-tab[aria-selected="true"], .title-bar-shell .title-bar-git-switch .title-bar-git[aria-expanded="true"], .title-bar-shell .title-bar-left-switch .title-bar-left-btn[aria-pressed="true"]': {
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
    background: `linear-gradient(135deg, ${monochrome.base} 0%, ${monochrome.surface} 52%, ${monochrome.raised} 100%)`
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
      background: palette.titleBar.surface,


      boxShadow: 'none'
    },
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
      transitionDuration: '0.01ms !important'
    },
    '.conn-flare-dot, .conn-idle-dot': { display: 'none' }
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
    '& .xterm-viewport': { scrollbarWidth: 'none' }
  },



  '.code-terminal-shell': {
    background: '#080808',
    borderColor: hairline.soft,
    '& .code-session-header': { background: monochrome.surface },
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
  '@layer base': baseLayer,




  ':focus-visible': { outline: '1px solid rgba(169,171,176,0.38)', outlineOffset: '1px', borderRadius: '10px' },







  '@layer components': componentsLayer
}
