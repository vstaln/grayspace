import { defineConfig, presetWind4 } from 'unocss'
import { presetTypography } from '@unocss/preset-typography'
import { geometry } from './src/renderer/src/ui/tokens'

/**
 * The only corner radii in the app. orcspace-ui.md names tokens.ts as the
 * source of geometry and lists exactly three; before this the renderer had
 * eleven ad-hoc pixel values (3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 9999) plus
 * five named Tailwind sizes, so no two panels agreed on a corner.
 *
 * bar   — edge-anchored chrome that meets the window frame (TitleBar, rails)
 * pill  — switches and compact controls
 * panel — every surface: modals, panels, cards, menus, widgets, rows
 */
const RADIUS: Record<string, string> = {
  bar: geometry.radiusBar,
  pill: geometry.radiusPill,
  panel: geometry.radiusPanel
}

const RADIUS_SIDES: Record<string, string[]> = {
  t: ['border-top-left-radius', 'border-top-right-radius'],
  b: ['border-bottom-left-radius', 'border-bottom-right-radius'],
  l: ['border-top-left-radius', 'border-bottom-left-radius'],
  r: ['border-top-right-radius', 'border-bottom-right-radius'],
  tl: ['border-top-left-radius'],
  tr: ['border-top-right-radius'],
  bl: ['border-bottom-left-radius'],
  br: ['border-bottom-right-radius']
}

export default defineConfig({
  presets: [
    presetWind4(),
    presetTypography()
  ],
  theme: {
    colors: {
      bg: {
        DEFAULT: 'var(--tok-color-bg)',
        raise: 'var(--tok-color-bg-raise)',
        panel: 'var(--tok-color-bg-panel)',
        hover: 'var(--tok-color-bg-hover)'
      },
      line: {
        DEFAULT: 'var(--tok-color-line)',
        soft: 'var(--tok-color-line-soft)'
      },
      text: {
        DEFAULT: 'var(--tok-color-text)',
        dim: 'var(--tok-color-text-dim)',
        faint: 'var(--tok-color-text-faint)'
      },
      accent: {
        DEFAULT: 'var(--tok-color-accent)',
        soft: 'var(--tok-color-accent-soft)'
      },
      danger: 'var(--tok-color-danger)',
      ok: 'var(--tok-color-ok)'
    },
    fontFamily: {
      sans: 'var(--tok-font-sans)'
    }
  },
  rules: [
    [/^rounded-(bar|pill|panel)$/, ([, name]) => ({ 'border-radius': RADIUS[name] })],
    [/^rounded-(t|b|l|r|tl|tr|bl|br)-(bar|pill|panel)$/, ([, side, name]) =>
      Object.fromEntries(RADIUS_SIDES[side].map((prop) => [prop, RADIUS[name]]))],
    [/^(w|h|min-w|max-w|left|right|top|bottom|inset|p|px|py|pt|pb|pl|pr|m|mx|my)-rail$/, ([, prop]) => {
      const longhand: Record<string, string> = {
        w: 'width',
        h: 'height',
        'min-w': 'min-width',
        'max-w': 'max-width',
        left: 'left',
        right: 'right',
        top: 'top',
        bottom: 'bottom',
        inset: 'inset',
        p: 'padding',
        px: 'padding-inline',
        py: 'padding-block',
        pt: 'padding-top',
        pb: 'padding-bottom',
        pl: 'padding-left',
        pr: 'padding-right',
        m: 'margin',
        mx: 'margin-inline',
        my: 'margin-block'
      }
      return { [longhand[prop]]: 'var(--tok-rail-width)' }
    }]
  ],
  variants: [
    (matcher) => {
      if (!matcher.startsWith('glass:')) return matcher
      return {
        matcher: matcher.slice(6),
        selector: (s) => `${s}:where(html[data-translucent] *)`
      }
    }
  ]
})
