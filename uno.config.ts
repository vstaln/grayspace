import { defineConfig, presetWind4 } from 'unocss'

/*
 * UnoCSS replaces Tailwind as the utility engine. Design values stay in
 * `design/tokens.ts` (mounted as `--tok-*` custom properties by installStyles);
 * the theme below only forwards those custom properties into utility names,
 * exactly like `tailwind.css` used to.
 *
 * The renderer keeps authoring utilities in JSX (`bg-bg-panel`, `text-xs`, вЂ¦);
 * nothing about the class vocabulary changes, only the engine that compiles it.
 */
export default defineConfig({
  presets: [presetWind4()],
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
  // Extra spacing sizes beyond the default scale (`--spacing-rail` did this in
  // the Tailwind theme): `w-rail`, `left-rail`.
  rules: [
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
    // `glass:` — applies when <html> carries data-translucent (the photo theme
    // floats panels over a blurred surface). Mirrors the Tailwind
    // definition: `&:where(html[data-translucent] *)`.
    (matcher) => {
      if (!matcher.startsWith('glass:')) return matcher
      return {
        matcher: matcher.slice(6),
        selector: (s) => `${s}:where(html[data-translucent] *)`
      }
    }
  ]
})
