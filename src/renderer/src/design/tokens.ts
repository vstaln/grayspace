/**
 * Every design value the app uses, in one typed place. Nothing here is a CSS
 * file: these objects are compiled to custom properties at start-up (see
 * `theme.ts`), and Tailwind's utilities read those properties by name, so a
 * colour is changed here and nowhere else.
 */

/** Palette shared by both themes — the flat, near-black graphite look. */
export const palette = {
  /** The one surface fill every floating shell uses, at 60% over its backdrop. */
  graphite: 'rgba(18, 18, 20, 0.6)',
  /** Same graphite fill as header and widget frame so terminal body matches header. */
  terminalGlass: 'rgba(18, 18, 20, 0.6)',
  /**
   * A raised surface *inside* an already-frosted shell (the chat composer). A
   * white lift rather than another dark fill: stacking graphite on graphite just
   * compounds toward opaque, while this stays see-through and reads as raised.
   */
  surfaceLift: 'rgba(255, 255, 255, 0.045)',
  white: '#ffffff',
  offWhite: '#f2f2f3',
  /** Fallback behind the photo theme when no picture is set (P2-207). */
  wallpaperBase: '#101013',
  scrollThumb: '#4a4a52',
  scrollThumbHover: '#6a6a74'
} as const

/** Hairlines are white at low alpha so they never band against a darker fill. */
export const hairline = {
  faint: 'rgba(255, 255, 255, 0.05)',
  soft: 'rgba(255, 255, 255, 0.06)',
  glassSoft: 'rgba(255, 255, 255, 0.07)',
  active: 'rgba(255, 255, 255, 0.15)',
  activeGlass: 'rgba(255, 255, 255, 0.2)',
  railActiveBorder: 'rgba(255, 255, 255, 0.16)',
  railActiveFill: 'rgba(255, 255, 255, 0.1)',
  railActiveGlassBorder: 'rgba(255, 255, 255, 0.55)'
} as const

/** Frosting strengths, paired so a shell's blur and saturation stay together. */
export const frost = {
  shell: 'blur(28px) saturate(160%)',
  surface: 'blur(40px) saturate(150%)',
  chat: 'blur(26px) saturate(140%)',
  board: 'blur(30px) saturate(160%)'
} as const

/** Kanban status tints: a dark fill plus a matching low-alpha border. */
export const lanes = {
  blue: { fill: '#0e1114', border: 'rgba(104, 200, 239, 0.2)', dot: '#68c8ef' },
  amber: { fill: '#131108', border: 'rgba(233, 184, 40, 0.2)', dot: '#e9b828' },
  green: { fill: '#0b1310', border: 'rgba(57, 189, 139, 0.2)', dot: '#39bd8b' },
  red: { fill: '#140d0f', border: 'rgba(221, 100, 123, 0.2)', dot: '#dd647b' }
} as const

/**
 * Named values Tailwind exposes as utilities (`bg-bg-raise`, `text-text-dim`,
 * `border-line`, …). The key is the utility suffix; the value is what the
 * custom property resolves to.
 */
export interface ThemeTokens {
  colorBg: string
  colorBgRaise: string
  colorBgPanel: string
  colorBgHover: string
  colorLine: string
  colorLineSoft: string
  colorText: string
  colorTextDim: string
  colorTextFaint: string
  colorAccent: string
  colorAccentSoft: string
  colorDanger: string
  colorOk: string
}

/**
 * Opaque theme: surfaces separate by a hairline and a step in lightness rather
 * than by gradients or shadow, so the UI reads as one quiet dark sheet.
 */
export const darkTokens: ThemeTokens = {
  colorBg: '#0a0a0b',
  colorBgRaise: '#101012',
  colorBgPanel: '#141417',
  colorBgHover: 'rgba(255, 255, 255, 0.05)',
  colorLine: 'rgba(255, 255, 255, 0.11)',
  colorLineSoft: 'rgba(255, 255, 255, 0.06)',
  colorText: '#f2f2f3',
  colorTextDim: '#b7b7bc',
  // 5.7:1 on colorBg — keeps the P3-217 contrast floor.
  colorTextFaint: '#8a8a90',
  colorAccent: '#ffffff',
  colorAccentSoft: 'rgba(255, 255, 255, 0.14)',
  colorDanger: '#e7a1a1',
  colorOk: '#6fd39a'
}

/** Translucent themes (`glass`, `photo`) sit over a blurred backdrop, so the
 *  base goes fully black and the text/lines lift slightly to stay readable. */
export const translucentTokens: ThemeTokens = {
  ...darkTokens,
  colorBg: '#000000',
  colorBgRaise: '#1a1a1d',
  colorBgPanel: '#17171a',
  colorBgHover: 'rgba(255, 255, 255, 0.07)',
  colorLine: 'rgba(255, 255, 255, 0.14)',
  colorLineSoft: 'rgba(255, 255, 255, 0.08)',
  colorText: '#f5f5f6',
  colorTextDim: '#cfcfd4',
  colorTextFaint: '#a0a0a7',
  colorAccentSoft: 'rgba(255, 255, 255, 0.2)'
}

export const typography = {
  sans: "'Inter', 'Segoe UI', system-ui, sans-serif"
} as const

export const geometry = {
  /** One radius for every panel, card, field and menu in the app. */
  radiusPanel: '10px',
  railWidth: '56px'
} as const

/** `colorBgRaise` → `--tok-color-bg-raise`, the name Tailwind's theme reads. */
export function toCustomProperty(token: keyof ThemeTokens): string {
  return `--tok-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}
