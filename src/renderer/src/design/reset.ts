import type { Sheet } from './css'

/*
 * Element-level reset, ported 1:1 from the Tailwind v4 preflight the app shipped
 * with. UnoCSS does not ship a preflight, so this keeps form controls, media
 * elements and heading/list defaults behaving exactly as before the switch.
 * Injected first by `installStyles`, so every later rule (utilities and the app
 * stylesheet) wins ties against it, same as `@layer base` did under Tailwind.
 */
export const resetSheet: Sheet = {
  '*, :after, :before, ::backdrop': {
    boxSizing: 'border-box',
    border: '0 solid',
    margin: 0,
    padding: 0
  },
  '::file-selector-button': {
    boxSizing: 'border-box',
    border: '0 solid',
    margin: '0 4px 0 0',
    padding: 0
  },
  'html, :host': {
    WebkitTextSizeAdjust: '100%',
    tabSize: 4,
    lineHeight: 1.5,
    fontFamily:
      "var(--tok-font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif)",
    WebkitTapHighlightColor: 'transparent'
  },
  hr: {
    height: 0,
    color: 'inherit',
    borderTopWidth: '1px'
  },
  'abbr:where([title])': {
    textDecoration: 'underline dotted'
  },
  'h1, h2, h3, h4, h5, h6': {
    fontSize: 'inherit',
    fontWeight: 'inherit'
  },
  a: {
    color: 'inherit',
    textDecoration: 'inherit'
  },
  'b, strong': {
    fontWeight: 'bolder'
  },
  'code, kbd, samp, pre': {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    fontFeatureSettings: 'normal',
    fontVariationSettings: 'normal',
    fontSize: '1em'
  },
  small: {
    fontSize: '80%'
  },
  'sub, sup': {
    verticalAlign: 'baseline',
    fontSize: '75%',
    lineHeight: 0,
    position: 'relative'
  },
  sub: { bottom: '-0.25em' },
  sup: { top: '-0.5em' },
  table: {
    textIndent: 0,
    borderColor: 'inherit',
    borderCollapse: 'collapse'
  },
  progress: { verticalAlign: 'baseline' },
  summary: { display: 'list-item' },
  'ol, ul, menu': { listStyle: 'none' },
  'img, svg, video, canvas, audio, iframe, embed, object': {
    verticalAlign: 'middle',
    display: 'block'
  },
  'img, video': {
    maxWidth: '100%',
    height: 'auto'
  },
  'button, input, select, optgroup, textarea': {
    font: 'inherit',
    fontFeatureSettings: 'inherit',
    fontVariationSettings: 'inherit',
    letterSpacing: 'inherit',
    color: 'inherit',
    opacity: 1,
    backgroundColor: 'transparent',
    borderRadius: 0
  },
  ':where(select:is([multiple], [size])) optgroup': { fontWeight: 'bolder' },
  ':where(select:is([multiple], [size])) optgroup option': { paddingInlineStart: '20px' },
  '::placeholder': {
    opacity: 1,
    color: 'color-mix(in oklab, currentcolor 50%, transparent)'
  },
  textarea: { resize: 'vertical' },
  '::-webkit-search-decoration': { WebkitAppearance: 'none' }
}
