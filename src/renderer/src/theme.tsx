import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type ThemeName = 'dark' | 'photo'

const STORAGE_KEY = 'workspace-theme'
export const THEMES: { id: ThemeName; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Opaque canvas' },
  { id: 'photo', label: 'Photo', hint: 'Custom wallpaper with adjustable blur & dim' }
]



const TRANSLUCENT: ThemeName[] = ['photo']

function readStoredTheme(): ThemeName {
  let saved: string | null = null
  try {
    saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  } catch {

  }
  return THEMES.some((t) => t.id === saved) ? (saved as ThemeName) : 'dark'
}

interface ThemeValue {
  theme: ThemeName
  setTheme: (theme: ThemeName) => void

  background: string | null

  backgroundLoaded: boolean

  dim: number
  setDim: (dim: number) => void

  blur: number
  setBlur: (blur: number) => void
  pickBackground: () => Promise<string | null>
  clearBackground: () => void

  error: string | null
}

const ThemeContext = createContext<ThemeValue>({
  theme: 'dark',
  setTheme: () => {},
  background: null,
  backgroundLoaded: false,
  dim: 20,
  setDim: () => {},
  blur: 40,
  setBlur: () => {},
  pickBackground: async () => null,
  clearBackground: () => {},
  error: null
})







export function wallpaperBackgroundImage(background: string | null): string | undefined {
  if (!background) return undefined
  if (!/^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]+$/i.test(background)) {
    return undefined
  }
  return `url("${background}")`
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeName>(readStoredTheme)
  const [background, setBackground] = useState<string | null>(null)
  const [backgroundLoaded, setBackgroundLoaded] = useState(false)
  const [dim, setDimState] = useState(20)
  const [blur, setBlurState] = useState(40)
  const [error, setError] = useState<string | null>(null)
  const backgroundRequestRef = useRef(0)
  const settingsRequestRef = useRef(0)

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)

    if (TRANSLUCENT.includes(theme)) root.setAttribute('data-translucent', '')
    else root.removeAttribute('data-translucent')
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {

    }
  }, [theme])



  useEffect(() => {
    const settingsRequest = ++settingsRequestRef.current
    void window.api.settings.get().then(
      (s) => {


        if (settingsRequest !== settingsRequestRef.current) return
        setDimState(s.backgroundDim ?? 45)
        setBlurState(s.backgroundBlur ?? 40)
      },
      () => {}
    )
    const backgroundRequest = ++backgroundRequestRef.current
    void window.api.settings.getBackground().then(
      (value) => {
        if (backgroundRequest === backgroundRequestRef.current) setBackground(value)
        if (backgroundRequest === backgroundRequestRef.current) setBackgroundLoaded(true)
      },
      () => {
        if (backgroundRequest === backgroundRequestRef.current) setBackground(null)
        if (backgroundRequest === backgroundRequestRef.current) setBackgroundLoaded(true)
      }
    )
  }, [])




  const dimTimerRef = useRef<number | null>(null)
  const setDim = useCallback((next: number): void => {
    const clamped = Math.min(90, Math.max(0, Math.round(next)))
    ++settingsRequestRef.current
    setDimState(clamped)
    if (dimTimerRef.current !== null) clearTimeout(dimTimerRef.current)
    dimTimerRef.current = window.setTimeout(() => {
      void window.api.settings.set({ backgroundDim: clamped }).catch(() => setError('Failed to save dimming level'))
    }, 300)
  }, [])
  const blurTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (dimTimerRef.current !== null) clearTimeout(dimTimerRef.current)
      if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current)
    },
    []
  )

  const setBlur = useCallback((next: number): void => {
    const clamped = Math.min(90, Math.max(0, Math.round(next)))
    ++settingsRequestRef.current
    setBlurState(clamped)
    if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current)
    blurTimerRef.current = window.setTimeout(() => {
      void window.api.settings.set({ backgroundBlur: clamped }).catch(() => setError('Failed to save blur level'))
    }, 300)
  }, [])

  const pickBackground = useCallback(async (): Promise<string | null> => {
    const request = ++backgroundRequestRef.current
    let result: { dataUrl?: string | null; error?: string }
    try {
      result = await window.api.settings.pickBackground()
    } catch (err) {
      if (request === backgroundRequestRef.current) {
        setError(`Failed to pick background: ${err instanceof Error ? err.message : String(err)}`)
      }
      return null
    }
    if (request !== backgroundRequestRef.current) return result.dataUrl ?? null
    if (result.error) {
      setError(result.error)
      return null
    }
    setError(null)
    const next = result.dataUrl ?? null
    setBackground(next)

    if (next) setTheme('photo')
    return next
  }, [])

  const clearBackground = useCallback(async (): Promise<void> => {
    ++backgroundRequestRef.current
    setError(null)


    setBackground(null)
    try {
      await window.api.settings.clearBackground()
    } catch (err) {
      setError(`Failed to remove background: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  return (
    <ThemeContext.Provider
      value={{ theme, setTheme, background, backgroundLoaded, dim, setDim, blur, setBlur, pickBackground, clearBackground, error }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}
