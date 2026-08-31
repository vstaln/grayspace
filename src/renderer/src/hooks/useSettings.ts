import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../../preload/index.d'

const DEFAULTS: AppSettings = {
  linkSyntax: 'both',
  windowsShell: 'cmd',
  role: 'lead',
  userName: 'you',
  backgroundDim: 45,
  backgroundBlur: 40,
  localModel: {
    enabled: false,
    serverBin: '',
    modelPath: '',
    contextSize: 32_768,
    gpuLayers: 99,
    idleTimeoutMs: 5 * 60_000,
    offloadVision: false
  },
  favoriteWidgets: ['terminal', 'files', 'sys-monitor', 'timer', 'planner', 'orchestration', 'browser', 'links', 'music-player', 'id-generator']
}

const FAVORITES_ALL_MIGRATION_KEY = 'orcspace-favorites-all-enabled'

/** Reads persisted app settings and writes patches straight through to disk. */
export function useSettings(): {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => Promise<void>
  /** Set when the last update() failed to persist, so UI can say so. */
  error: string | null
} {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS)
  const [error, setError] = useState<string | null>(null)
  // The initial get() is in flight while onChange broadcasts and update()
  // calls can already be landing. Without a guard the stale fetch would
  // overwrite a newer value with an older snapshot (a race the board's own
  // seq-guard pattern exists to prevent elsewhere).
  const initSeqRef = useRef(0)

  useEffect(() => {
    const seq = ++initSeqRef.current
    const mergeDefaults = (s: AppSettings): AppSettings => ({
      ...DEFAULTS,
      ...s,
      favoriteWidgets: (s.favoriteWidgets ?? DEFAULTS.favoriteWidgets ?? []).filter((kind) => kind !== 'translator')
    })

    void window.api.settings
      .get()
      .then((s) => {
        if (seq === initSeqRef.current) setSettings(mergeDefaults(s))
        try {
          if (!localStorage.getItem(FAVORITES_ALL_MIGRATION_KEY)) {
            localStorage.setItem(FAVORITES_ALL_MIGRATION_KEY, '1')
            void window.api.settings.set({ favoriteWidgets: DEFAULTS.favoriteWidgets })
            setSettings((prev) => ({ ...prev, favoriteWidgets: DEFAULTS.favoriteWidgets }))
          }
        } catch {}
      })
      .catch((err) => console.warn('settings:get failed', err))
    const offSettings = window.api.settings.onChange((s) => {
      initSeqRef.current += 1
      setSettings(mergeDefaults(s as AppSettings))
    })
    return () => {
      initSeqRef.current += 1
      offSettings()
    }
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    // A mount-time get() still in flight must not overwrite this update.
    const seq = ++initSeqRef.current
    setError(null)
    setSettings((prev) => ({ ...prev, ...patch }))
    try {
      const next = (await window.api.settings.set(patch)) as AppSettings
      if (seq === initSeqRef.current && next && typeof next === 'object') {
        setSettings(next)
      }
    } catch (err) {
      // Keep the optimistic state, but SAY the write failed — a settings save
      // that dies silently is indistinguishable from a saved one in the UI.
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  return { settings, update, error }
}
