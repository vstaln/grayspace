import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type ThemeName = 'dark' | 'photo'

const STORAGE_KEY = 'workspace-theme'
export const THEMES: { id: ThemeName; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Opaque canvas' },
  { id: 'photo', label: 'Photo', hint: 'Custom wallpaper with adjustable blur & dim' }
]

/** `photo` floats panels on a blurred, semi-opaque surface over the real
 *  desktop showing through the transparent window. */
const TRANSLUCENT: ThemeName[] = ['photo']

function readStoredTheme(): ThemeName {
  let saved: string | null = null
  try {
    saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  } catch {
    // Storage can be unavailable in restricted/sandboxed renderer contexts.
  }
  return THEMES.some((t) => t.id === saved) ? (saved as ThemeName) : 'dark'
}

interface ThemeValue {
  theme: ThemeName
  setTheme: (theme: ThemeName) => void
  /** Data URL of the wallpaper, or null when the user has not picked one. */
  background: string | null
  /** 0–90: percent of black laid over the wallpaper. */
  dim: number
  setDim: (dim: number) => void
  /** 0–90: percent of Gaussian blur applied to the wallpaper. */
  blur: number
  setBlur: (blur: number) => void
  pickBackground: () => Promise<string | null>
  clearBackground: () => void
  /** Set when the last pick failed, so the settings menu can explain why. */
  error: string | null
}

const ThemeContext = createContext<ThemeValue>({
  theme: 'dark',
  setTheme: () => {},
  background: null,
  dim: 45,
  setDim: () => {},
  blur: 40,
  setBlur: () => {},
  pickBackground: async () => null,
  clearBackground: () => {},
  error: null
})

/** Applies the theme to <html data-theme> (CSS hooks into that) and persists it. */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeName>(readStoredTheme)
  const [background, setBackground] = useState<string | null>(null)
  const [dim, setDimState] = useState(45)
  const [blur, setBlurState] = useState(40)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    // A single flag lets every translucent rule target both themes at once.
    if (TRANSLUCENT.includes(theme)) root.setAttribute('data-translucent', '')
    else root.removeAttribute('data-translucent')
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // The theme still applies for this session when persistence is blocked.
    }
  }, [theme])

  // The wallpaper and its dim live in the main process (they outgrow localStorage
  // and must survive a cache clear), so they are loaded once on mount.
  useEffect(() => {
    void window.api.settings.get().then(
      (s) => {
        setDimState(s.backgroundDim ?? 45)
        setBlurState(s.backgroundBlur ?? 40)
      },
      () => {}
    )
    void window.api.settings.getBackground().then(setBackground, () => setBackground(null))
  }, [])

  // PERF-003: the dim slider fires on every step; keep the UI instant but
  // collapse the IPC+writeJsonAtomic+fsync storm into one call after the
  // slider settles — the last value is what should reach disk anyway.
  const dimTimerRef = useRef<number | null>(null)
  const setDim = useCallback((next: number): void => {
    const clamped = Math.min(90, Math.max(0, Math.round(next)))
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
    setBlurState(clamped)
    if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current)
    blurTimerRef.current = window.setTimeout(() => {
      void window.api.settings.set({ backgroundBlur: clamped }).catch(() => setError('Failed to save blur level'))
    }, 300)
  }, [])

  const pickBackground = useCallback(async (): Promise<string | null> => {
    let result: { dataUrl?: string | null; error?: string }
    try {
      result = await window.api.settings.pickBackground()
    } catch (err) {
      setError(`Failed to pick background: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    if (result.error) {
      setError(result.error)
      return null
    }
    setError(null)
    const next = result.dataUrl ?? null
    setBackground(next)
    // Picking a picture is only ever meant to show it, so switch themes for them.
    if (next) setTheme('photo')
    return next
  }, [])

  const clearBackground = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      await window.api.settings.clearBackground()
      setBackground(null)
    } catch (err) {
      setError(`Failed to remove background: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  return (
    <ThemeContext.Provider
      value={{ theme, setTheme, background, dim, setDim, blur, setBlur, pickBackground, clearBackground, error }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}
