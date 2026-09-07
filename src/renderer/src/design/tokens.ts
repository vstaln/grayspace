/**
 * Every design value the app uses, in one typed place. Nothing here is a CSS
 * file: these objects are compiled to custom properties at start-up (see
 * `theme.ts`), and UnoCSS utilities read those properties by name, so a
 * colour is changed here and nowhere else.
 */

/** Palette shared by both themes — the flat, near-black graphite look. */
export const palette = {
  /** Monochrome system: deep, surface and silver are the only visual anchors. */
  graphite: 'rgba(9, 10, 12, 0.82)',
  /** Opaque Code-terminal fill. Canvas terminals opt into the transparent
   *  xterm theme and use `terminalGlass` for their frame instead. */
  terminalSolid: '#0b0b0d',
  /** Canvas terminal frame: a dark translucent veil (~20% transparency / 80% opacity)
   *  so the wallpaper shines through beautifully between glyphs. The xterm canvas
   *  itself is transparent in this mode — Code section terminals stay solid black instead. */
  terminalGlass: 'rgba(10, 11, 15, 0.80)',
  /** Fixed title-bar palette: base window, control surface, active control. */
  titleBar: {
    base: '#090a0c',
    surface: '#1C1C1F',
    active: '#292c32'
  },
  white: '#ffffff',
  /** Fallback behind the photo theme when no picture is set (P2-207). */
  wallpaperBase: '#0b0c0f',
  scrollThumb: '#555a63',
  scrollThumbHover: '#747a84'
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
  board: 'blur(30px) saturate(160%)',
  /** Canvas terminal glass: 18px blur plus ~18% dimming (brightness 0.82) so text stays
   *  crisp and readable over busy wallpaper. */
  terminal: 'blur(18px) brightness(0.82)'
} as const

/** Kanban status tints preserve the semantic colour of each workflow state. */
export const lanes = {
  blue: { fill: '#0e1114', border: 'rgba(104, 200, 239, 0.2)', dot: '#68c8ef' },
  amber: { fill: '#131108', border: 'rgba(233, 184, 40, 0.2)', dot: '#e9b828' },
  green: { fill: '#0b1310', border: 'rgba(57, 189, 139, 0.2)', dot: '#39bd8b' },
  red: { fill: '#140d0f', border: 'rgba(221, 100, 123, 0.2)', dot: '#dd647b' }
} as const

/**
 * Named values UnoCSS exposes as utilities (`bg-bg-raise`, `text-text-dim`,
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
  colorBg: '#08090b',
  colorBgRaise: '#101216',
  colorBgPanel: '#17191d',
  colorBgHover: 'rgba(255, 255, 255, 0.05)',
  colorLine: 'rgba(255, 255, 255, 0.11)',
  colorLineSoft: 'rgba(255, 255, 255, 0.06)',
  colorText: '#e7e9ed',
  colorTextDim: '#b7bbc3',
  // 5.7:1 on colorBg — keeps the P3-217 contrast floor.
  colorTextFaint: '#8a8a90',
  colorAccent: '#ffffff',
  colorAccentSoft: 'rgba(255, 255, 255, 0.14)',
  colorDanger: '#e7a1a1',
  colorOk: '#6fd39a'
}

/** The translucent theme (`photo`) sits over a blurred backdrop, so the
 *  base goes fully black and the text/lines lift slightly to stay readable. */
export const translucentTokens: ThemeTokens = {
  ...darkTokens,
  colorBg: '#050608',
  colorBgRaise: '#111317',
  colorBgPanel: '#15171b',
  colorBgHover: 'rgba(255, 255, 255, 0.07)',
  colorLine: 'rgba(255, 255, 255, 0.14)',
  colorLineSoft: 'rgba(255, 255, 255, 0.08)',
  colorText: '#eceef2',
  colorTextDim: '#c4c8d0',
  colorTextFaint: '#969ba5',
  colorAccentSoft: 'rgba(255, 255, 255, 0.2)'
}

export const typography = {
  sans: "'Inter', 'Segoe UI', system-ui, sans-serif"
} as const

export const geometry = {
  /** One radius for every panel, card, field and menu in the app. */
  radiusPanel: '10px',
  railWidth: '56px',
  /** Full-pane left offsets mirror the app sidebar, which is expanded whenever
   *  a full pane (Browser/Chat/Code) is visible: 200px normally, 240px in chat.
   *  BrowserPane/ChatPane/CodeView use these as their shared left offset. */
  sidebarExpanded: '200px',
  sidebarExpandedChat: '240px'
} as const

/** `colorBgRaise` → `--tok-color-bg-raise`, the name UnoCSS's theme reads. */
export function toCustomProperty(token: keyof ThemeTokens): string {
  return `--tok-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}
