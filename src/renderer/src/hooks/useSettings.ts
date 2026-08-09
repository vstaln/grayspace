import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '../../../preload/index.d'

const DEFAULTS: AppSettings = { linkSyntax: 'both', role: 'member', userName: 'you', backgroundDim: 45 }

/** Reads persisted app settings and writes patches straight through to disk. */
export function useSettings(): { settings: AppSettings; update: (patch: Partial<AppSettings>) => Promise<void> } {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    setSettings(await window.api.settings.set(patch))
  }, [])

  return { settings, update }
}
