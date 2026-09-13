import { useEffect, useRef, useState } from 'react'
import type { AppUpdateState } from '../../../preload/api'

export function AppUpdates(): React.JSX.Element {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.settings.updateState()
        if (active) { setState(next); setError('') }
      } catch { if (active) setError('Unable to read update status.') }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const act = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (state?.status === 'ready') {
        await window.api.settings.installUpdate()
        if (!mountedRef.current) return
        setState(await window.api.settings.updateState())
      } else {
        const next = await window.api.settings.checkUpdates()
        if (!mountedRef.current) return
        setState(next)
      }
    } catch {
      if (!mountedRef.current) return
      setError('Unable to update. Please try again.')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }
  const status = state?.status
  const message = state?.message || (status === 'checking' ? 'Checking for updates…'
    : status === 'downloading' ? `Downloading ${state?.version}: ${Math.round(state?.percent ?? 0)}%`
    : status === 'ready' ? `Version ${state?.version} is ready. Restarting will close running terminals.`
    : status === 'installing' ? 'Restarting to install…'
    : status === 'current' ? 'You are up to date.' : 'Check and download the latest version.')
  return <section className="flex flex-col gap-3 border-t border-line pt-5" aria-label="App updates">
    <h3 className="text-xs font-medium text-text">Updates {state && <span className="text-text-faint">· {state.currentVersion}</span>}</h3>
    <p role="status" className="text-[11px] text-text-faint">{error || message}</p>
    {status === 'downloading' && <progress aria-label="Update download" max={100} value={state?.percent ?? 0} className="w-full" />}
    <button type="button" className="self-start rounded-[8px] border border-line px-3 py-2 text-xs text-text hover:bg-bg-hover disabled:opacity-50"
      disabled={busy || !state || !status || ['disabled', 'checking', 'downloading', 'installing'].includes(status)}
      onClick={() => void act()}>{status === 'ready' ? 'Restart and install' : 'Check for updates'}</button>
  </section>
}
