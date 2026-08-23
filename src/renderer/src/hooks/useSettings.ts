import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, McpStatus } from '../../../preload/index.d'

const DEFAULTS: AppSettings = {
  linkSyntax: 'both',
  role: 'lead',
  plan: 'free',
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
  }
}

const PLAN_STORAGE_KEY = 'orcspace-user-plan'

/** Reads persisted app settings and writes patches straight through to disk. */
export function useSettings(): {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => Promise<void>
  mcpStatus: McpStatus | null
  restartMcp: () => Promise<void>
  /** Set when the last update() failed to persist, so UI can say so. */
  error: string | null
} {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const savedPlan = localStorage.getItem(PLAN_STORAGE_KEY) as 'free' | 'plus' | null
      if (savedPlan) return { ...DEFAULTS, plan: savedPlan }
    } catch {}
    return DEFAULTS
  })
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The initial get() is in flight while onChange broadcasts and update()
  // calls can already be landing. Without a guard the stale fetch would
  // overwrite a newer value with an older snapshot (a race the board's own
  // seq-guard pattern exists to prevent elsewhere).
  const initSeqRef = useRef(0)

  useEffect(() => {
    const seq = ++initSeqRef.current
    const mergePlan = (s: AppSettings): AppSettings => {
      try {
        const localPlan = localStorage.getItem(PLAN_STORAGE_KEY) as 'free' | 'plus' | null
        if (localPlan) return { ...s, plan: localPlan }
      } catch {}
      return s
    }

    void window.api.settings
      .get()
      .then((s) => {
        if (seq === initSeqRef.current) setSettings(mergePlan(s))
      })
      .catch((err) => console.warn('settings:get failed', err))
    void window.api.mcp.getStatus().then(setMcpStatus).catch((err) => console.warn('mcp:getStatus failed', err))
    const offSettings = window.api.settings.onChange((s) => {
      initSeqRef.current += 1
      setSettings(mergePlan(s as AppSettings))
    })
    const offMcp = window.api.mcp.onStatusChange(setMcpStatus)
    return () => {
      initSeqRef.current += 1
      offSettings()
      offMcp()
    }
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    // A mount-time get() still in flight must not overwrite this update.
    initSeqRef.current += 1
    setError(null)
    if (patch.plan) {
      try {
        localStorage.setItem(PLAN_STORAGE_KEY, patch.plan)
      } catch {}
    }
    setSettings((prev) => ({ ...prev, ...patch }))
    try {
      const next = (await window.api.settings.set(patch)) as AppSettings
      if (next && typeof next === 'object') {
        const localPlan = (localStorage.getItem(PLAN_STORAGE_KEY) as 'free' | 'plus' | null) || patch.plan
        setSettings({ ...next, ...(localPlan ? { plan: localPlan } : {}) })
      }
    } catch (err) {
      // Keep the optimistic state, but SAY the write failed — a settings save
      // that dies silently is indistinguishable from a saved one in the UI.
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const restartMcp = useCallback(async (): Promise<void> => {
    try {
      setMcpStatus(await window.api.mcp.restart())
    } catch (err) {
      console.error('Failed to restart MCP server:', err)
    }
  }, [])

  return { settings, update, mcpStatus, restartMcp, error }
}
