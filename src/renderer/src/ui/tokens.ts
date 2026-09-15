







export const monochrome = {
  base: '#080808',
  terminalHeader: '#0D0D0D',
  surface: '#121212',
  elevated: '#181818',
  raised: '#1F1F1F'
} as const

export const palette = {
  terminalSolid: monochrome.base,



  terminalGlass: 'rgba(8, 8, 8, 0.20)',

  titleBar: {
    base: monochrome.base,
    surface: monochrome.surface,
    active: monochrome.raised
  },
  white: '#ffffff',

  wallpaperBase: monochrome.base,
  scrollThumb: monochrome.raised,
  scrollThumbHover: '#2A2A2E'
} as const


export const hairline = {
  faint: '#2A2A2E',
  soft: monochrome.raised,
  glassSoft: monochrome.raised,
  active: monochrome.raised,
  activeGlass: monochrome.raised,
  railActiveBorder: monochrome.surface,
  railActiveFill: monochrome.raised,
  railActiveGlassBorder: monochrome.raised
} as const


export const frost = {
  shell: 'blur(28px) saturate(160%)',
  surface: 'blur(40px) saturate(150%)',


  terminal: 'blur(20px)'
} as const






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





export const darkTokens: ThemeTokens = {
  colorBg: monochrome.base,
  colorBgRaise: monochrome.surface,
  colorBgPanel: monochrome.elevated,
  colorBgHover: monochrome.raised,
  colorLine: '#2A2A2E',
  colorLineSoft: monochrome.raised,
  colorText: '#ffffff',
  colorTextDim: '#B9B9BE',

  colorTextFaint: '#A9A9B0',
  colorAccent: '#ffffff',
  colorAccentSoft: 'rgba(255, 255, 255, 0.14)',
  colorDanger: '#e7a1a1',
  colorOk: '#6fd39a'
}



export const translucentTokens: ThemeTokens = {
  ...darkTokens,
  colorText: '#ffffff',
  colorTextDim: '#B9B9BE',
  colorTextFaint: '#A9A9B0',
  colorAccentSoft: 'rgba(255, 255, 255, 0.2)'
}

export const typography = {
  sans: "'Inter', 'Segoe UI', system-ui, sans-serif"
} as const

export const geometry = {

  radiusBar: '0',
  radiusPill: '999px',
  radiusPanel: '12px',
  railWidth: '56px',

  sidebarExpanded: '200px',
} as const


export function toCustomProperty(token: keyof ThemeTokens): string {
  return `--tok-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}
