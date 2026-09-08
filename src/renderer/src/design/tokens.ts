







export const monochrome = {
  base: '#08090b',
  surface: '#15171b',
  graphite: '#a9abb0'
} as const

export const palette = {
  graphite: 'rgba(9, 10, 12, 0.82)',


  terminalSolid: '#0b0b0d',



  terminalGlass: 'rgba(10, 11, 15, 0.80)',

  titleBar: {
    base: '#090a0c',
    surface: '#1C1C1F',
    active: '#292c32'
  },
  white: '#ffffff',

  wallpaperBase: '#0b0c0f',
  scrollThumb: '#555a63',
  scrollThumbHover: '#747a84'
} as const


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


export const frost = {
  shell: 'blur(28px) saturate(160%)',
  surface: 'blur(40px) saturate(150%)',


  terminal: 'blur(16px) brightness(0.88)'
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
  colorBg: '#08090b',
  colorBgRaise: '#101216',
  colorBgPanel: '#17191d',
  colorBgHover: 'rgba(255, 255, 255, 0.05)',
  colorLine: 'rgba(255, 255, 255, 0.11)',
  colorLineSoft: 'rgba(255, 255, 255, 0.06)',
  colorText: '#e7e9ed',
  colorTextDim: '#b7bbc3',

  colorTextFaint: '#8a8a90',
  colorAccent: '#ffffff',
  colorAccentSoft: 'rgba(255, 255, 255, 0.14)',
  colorDanger: '#e7a1a1',
  colorOk: '#6fd39a'
}



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

  radiusPanel: '10px',
  railWidth: '56px',

  sidebarExpanded: '200px',
} as const


export function toCustomProperty(token: keyof ThemeTokens): string {
  return `--tok-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}
