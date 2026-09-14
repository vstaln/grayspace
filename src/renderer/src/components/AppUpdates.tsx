import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDownToLine, Check, Loader2, RotateCw } from 'lucide-react'
import type { AppUpdateState } from '../../../preload/api'
import { UpdateCurtain } from './UpdateCurtain'

type Tone = 'accent' | 'ok' | 'danger' | 'plain'

// The silent installer gives no progress of its own, so the curtain walks a
// believable arc instead: quick to most of the way, then patient.
const INSTALL_MS = 11_000
const installCurve = (elapsed: number): number => {
  const t = Math.min(1, elapsed / INSTALL_MS)
  return Math.min(99, Math.round((1 - Math.pow(1 - t, 2.4)) * 99))
}

const TONE_CLASS: Record<Tone, string> = {
  accent: 'border-accent-soft bg-accent-soft text-accent',
  ok: 'border-line-soft bg-bg-hover text-ok',
  danger: 'border-line-soft bg-bg-hover text-danger',
  plain: 'border-line-soft bg-bg-hover text-text-dim'
}

export function AppUpdates(): React.JSX.Element {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [curtain, setCurtain] = useState<{ percent: number } | null>(null)
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
  const curtainOpen = curtain !== null
  useEffect(() => {
    if (!curtainOpen) return
    const started = performance.now()
    const timer = setInterval(() => {
      const percent = installCurve(performance.now() - started)
      setCurtain((current) => current ? { ...current, percent } : current)
    }, 90)
    return () => clearInterval(timer)
  }, [curtainOpen])
  const act = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (state?.status === 'ready') {
        setCurtain({ percent: 0 })
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
      setCurtain(null)
      setError('Unable to update. Please try again.')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }
  const status = state?.status
  const working = status === 'checking' || status === 'downloading' || status === 'installing'
  const percent = Math.max(0, Math.min(100, Math.round(state?.percent ?? 0)))
  const headline = error ? 'Update failed'
    : status === 'checking' ? 'Checking for updates…'
    : status === 'downloading' ? `Downloading ${state?.version ?? 'the update'}`
    : status === 'ready' ? `Version ${state?.version} is ready`
    : status === 'installing' ? 'Restarting to install…'
    : status === 'current' ? 'You are up to date'
    : status === 'error' ? 'Update failed'
    : status === 'disabled' ? 'Updates are unavailable here'
    : 'A new version may be waiting'
  const detail = error || state?.message || (status === 'downloading' ? `${percent}% of the installer downloaded`
    : status === 'ready' ? 'Restarting will close running terminals.'
    : status === 'current' ? `OrcSpace ${state?.currentVersion} is the latest release.`
    : status === 'checking' || status === 'installing' ? ''
    : 'Check and download the latest version.')
  const tone: Tone = error || status === 'error' ? 'danger'
    : status === 'ready' ? 'accent'
    : status === 'current' ? 'ok' : 'plain'
  const icon = working ? <Loader2 size={15} className="animate-spin" aria-hidden />
    : error || status === 'error' ? <AlertCircle size={15} aria-hidden />
    : status === 'ready' ? <ArrowDownToLine size={15} aria-hidden />
    : status === 'current' ? <Check size={15} aria-hidden />
    : <RotateCw size={15} aria-hidden />
  const disabled = busy || !state || !status || ['disabled', 'checking', 'downloading', 'installing'].includes(status)
  return <section className="flex flex-col gap-2.5 border-t border-line pt-5" aria-label="App updates">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-medium text-text">Updates</h3>
      {state && <span className="rounded-full border border-line-soft bg-bg-hover px-2 py-0.5 text-[10px] font-medium text-text-faint">{state.currentVersion}</span>}
    </div>
    <div className="flex flex-col gap-3 overflow-hidden rounded-[14px] border border-line-soft bg-bg-raise p-3.5">
      <div className="flex items-start gap-2.5">
        <span className={`grid h-8 w-8 flex-none place-items-center rounded-[10px] border ${TONE_CLASS[tone]}`}>{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-[11.5px] font-medium text-text">{headline}</p>
          {detail && <p role="status" aria-live="polite" className="text-[11px] leading-relaxed text-text-faint">{detail}</p>}
        </div>
        {status === 'downloading' && <span className="flex-none text-[11px] font-medium tabular-nums text-text-dim">{percent}%</span>}
      </div>
      {status === 'downloading' && (
        <div role="progressbar" aria-label="Update download" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
          className="h-1.5 w-full overflow-hidden rounded-full bg-bg-hover">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${percent}%` }} />
        </div>
      )}
      <button type="button"
        className={`flex min-h-[34px] items-center justify-center gap-1.5 self-start rounded-[10px] px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${
          status === 'ready' ? 'bg-accent text-bg hover:opacity-90' : 'border border-line-soft text-text hover:bg-bg-hover'
        }`}
        disabled={disabled}
        onClick={() => void act()}>
        {status === 'ready' ? <ArrowDownToLine size={13} aria-hidden /> : <RotateCw size={13} className={working ? 'animate-spin' : ''} aria-hidden />}
        {status === 'ready' ? 'Restart and install' : status === 'error' || error ? 'Try again' : 'Check for updates'}
      </button>
    </div>
    {curtain && <UpdateCurtain percent={curtain.percent} label={`Updating OrcSpace${state?.version ? ` to ${state.version}` : ''}`} />}
  </section>
}
