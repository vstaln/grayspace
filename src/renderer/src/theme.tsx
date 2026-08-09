import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type ThemeName = 'dark' | 'glass' | 'photo'

const STORAGE_KEY = 'workspace-theme'
export const THEMES: { id: ThemeName; label: string; hint: string }[] = [
  { id: 'dark', label: 'Тёмная', hint: 'Непрозрачный фон' },
  { id: 'glass', label: 'Стеклянная', hint: 'Полупрозрачные панели поверх рабочего стола' },
  { id: 'photo', label: 'Фото', hint: 'Своё изображение с настраиваемым затемнением' }
]

/** `glass` and `photo` both put panels on a blurred, semi-opaque surface. */
const TRANSLUCENT: ThemeName[] = ['glass', 'photo']

function readStoredTheme(): ThemeName {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
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
  pickBackground: async () => null,
  clearBackground: () => {},
  error: null
})

/** Applies the theme to <html data-theme> (CSS hooks into that) and persists it. */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeName>(readStoredTheme)
  const [background, setBackground] = useState<string | null>(null)
  const [dim, setDimState] = useState(45)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    // A single flag lets every translucent rule target both themes at once.
    if (TRANSLUCENT.includes(theme)) root.setAttribute('data-translucent', '')
    else root.removeAttribute('data-translucent')
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  // The wallpaper and its dim live in the main process (they outgrow localStorage
  // and must survive a cache clear), so they are loaded once on mount.
  useEffect(() => {
    // Tolerate an older main process (a stale dev build with no wallpaper IPC):
    // the theme still works, it just has nothing to show.
    void window.api.settings.get().then((s) => setDimState(s.backgroundDim ?? 45), () => {})
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
      void window.api.settings.set({ backgroundDim: clamped })
    }, 300)
  }, [])
  useEffect(
    () => () => {
      if (dimTimerRef.current !== null) clearTimeout(dimTimerRef.current)
    },
    []
  )

  const pickBackground = useCallback(async (): Promise<string | null> => {
    const result = await window.api.settings.pickBackground()
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

  const clearBackground = useCallback((): void => {
    setError(null)
    setBackground(null)
    void window.api.settings.clearBackground()
  }, [])

  return (
    <ThemeContext.Provider
      value={{ theme, setTheme, background, dim, setDim, pickBackground, clearBackground, error }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}
