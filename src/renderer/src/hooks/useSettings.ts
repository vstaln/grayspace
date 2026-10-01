import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../../preload/index.d'
import { normalizeCustomCodeAgents } from '../../../shared/customCodeAgents'

const DEFAULTS: AppSettings = {
  linkSyntax: 'both',
  windowsShell: 'cmd',
  commandPrefix: 'any',
  userName: 'you',
  backgroundDim: 45,
  backgroundBlur: 40,
  aiProvider: 'chatgpt',
  aiModel: 'gpt-5.6-sol',
  aiReasoningEffort: 'medium',
  aiConnectedProviders: [],
  localModel: {
    enabled: false,
    serverBin: '',
    modelPath: '',
    contextSize: 32_768,
    gpuLayers: 99,
    idleTimeoutMs: 5 * 60_000,
    offloadVision: false
  },
  favoriteWidgets: ['terminal', 'files', 'sys-monitor', 'timer', 'planner', 'orchestration', 'browser', 'image', 'links', 'music-player', 'chat', 'notes', 'calendar', 'kanban'],
  favoriteTerminalNames: [],
  customCodeAgents: [],
  imageInsertShortcut: 'Mod+Shift+I',
  autoApprovePermissions: false
}

const FAVORITES_ALL_MIGRATION_KEY = 'orcspace-favorites-all-enabled'
const CHAT_FAVORITE_MIGRATION_KEY = 'orcspace-chat-favorite-enabled'
const AI_MODEL_MIGRATIONS: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-opus-4-1': 'claude-opus-5',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'grok-4': 'grok-4.6',
  'grok-4-fast': 'grok-4.6',
  'grok-3-mini': 'grok-4.3'
}

function mergeDefaults(s: AppSettings): AppSettings {
  return {
    ...DEFAULTS,
    ...s,
    aiModel: typeof s.aiModel === 'string' ? AI_MODEL_MIGRATIONS[s.aiModel] ?? s.aiModel : DEFAULTS.aiModel,
    favoriteWidgets: (s.favoriteWidgets ?? DEFAULTS.favoriteWidgets ?? []).filter(
      (kind) => kind !== 'translator' && kind !== 'id-generator' && kind !== 'note'
    ),
    favoriteTerminalNames: Array.isArray(s.favoriteTerminalNames)
      ? s.favoriteTerminalNames.filter((name): name is string => typeof name === 'string')
      : (DEFAULTS.favoriteTerminalNames ?? []),
    customCodeAgents: normalizeCustomCodeAgents(s.customCodeAgents)
  }
}


export function useSettings(): {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => Promise<boolean>

  error: string | null
} {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS)
  const [error, setError] = useState<string | null>(null)



  const initSeqRef = useRef(0)

  useEffect(() => {
    const seq = ++initSeqRef.current
    void window.api.settings
      .get()
      .then((s) => {


        if (seq !== initSeqRef.current) return
        setSettings(mergeDefaults(s))
        try {
          if (!localStorage.getItem(FAVORITES_ALL_MIGRATION_KEY)) {
            localStorage.setItem(FAVORITES_ALL_MIGRATION_KEY, '1')

            const needed = (DEFAULTS.favoriteWidgets ?? []).filter((k) => !(s.favoriteWidgets ?? []).includes(k as never))
            const pruned = (s.favoriteWidgets ?? []).filter((k) => k !== 'translator' && k !== 'id-generator' && k !== 'note')
            if (needed.length || pruned.length !== (s.favoriteWidgets ?? []).length) {
              const merged = Array.from(new Set([...pruned, ...needed]))
              void window.api.settings.set({ favoriteWidgets: merged }).catch((err) => {
                if (seq === initSeqRef.current) setError(err instanceof Error ? err.message : String(err))
              })
              if (seq === initSeqRef.current) {
                setSettings((prev) => ({ ...prev, favoriteWidgets: merged }))
              }
            }
          }
          if (!localStorage.getItem(CHAT_FAVORITE_MIGRATION_KEY) && !(s.favoriteWidgets ?? []).includes('chat')) {
            localStorage.setItem(CHAT_FAVORITE_MIGRATION_KEY, '1')
            const merged = [...(s.favoriteWidgets ?? []), 'chat']
            void window.api.settings.set({ favoriteWidgets: merged }).catch((err) => {
              if (seq === initSeqRef.current) setError(err instanceof Error ? err.message : String(err))
            })
            if (seq === initSeqRef.current) setSettings((prev) => ({ ...prev, favoriteWidgets: merged }))
          } else if (!localStorage.getItem(CHAT_FAVORITE_MIGRATION_KEY)) {
            localStorage.setItem(CHAT_FAVORITE_MIGRATION_KEY, '1')
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

  const update = useCallback(async (patch: Partial<AppSettings>): Promise<boolean> => {

    const seq = ++initSeqRef.current
    setError(null)
    setSettings((prev) => {

      if (patch.localModel && typeof patch.localModel === 'object') {
        return { ...prev, ...patch, localModel: { ...prev.localModel, ...patch.localModel as typeof prev.localModel } }
      }
      return { ...prev, ...patch }
    })
    try {
      const next = (await window.api.settings.set(patch)) as AppSettings
      if (seq === initSeqRef.current && next && typeof next === 'object') {
        setSettings(mergeDefaults(next))
      }
      return true
    } catch (err) {


      if (seq === initSeqRef.current) setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [])

  return { settings, update, error }
}
