import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDownToLine, Check, ExternalLink, Loader2, RotateCw } from 'lucide-react'
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

/**
 * Statuses that only a click can move on from, so there is nothing to poll
 * for while the app sits in one of them.
 */
const SETTLED_STATUS = new Set<AppUpdateState['status']>(['disabled', 'idle', 'current', 'available', 'error'])

/** Field-by-field, because each poll answer arrives as a fresh object. */
function sameUpdateState(a: AppUpdateState | null, b: AppUpdateState): boolean {
  return a !== null &&
    a.status === b.status &&
    a.currentVersion === b.currentVersion &&
    a.version === b.version &&
    a.percent === b.percent &&
    a.message === b.message
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
  // The main process holds the update state and has no way to push it, so it
  // is polled — but only while something is actually moving. `disabled`,
  // `current`, `idle` and `error` change only in response to a click, which
  // sets the state directly, so polling through them asked the main process
  // the same question every two seconds for the lifetime of the app. Each
  // answer also arrived structure-cloned, a new object every time, so the
  // unconditional setState re-rendered this component forever.
  // Polling is driven by the status itself rather than a flag, so the click
  // handlers that set `checking`/`installing` directly start it again without
  // having to know it exists.
  const settled = state !== null && SETTLED_STATUS.has(state.status)
  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.settings.updateState()
        if (!active) return
        setState((current) => (sameUpdateState(current, next) ? current : next))
        setError('')
      } catch { if (active) setError('Unable to read update status.') }
    }
    void refresh()
    if (settled) return () => { active = false }
    const timer = setInterval(() => void refresh(), 2000)
    return () => { active = false; clearInterval(timer) }
  }, [settled])
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
      } else if (state?.status === 'available') {
        // Manual installs: the main process opens the release page.
        await window.api.settings.installUpdate()
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
    : status === 'available' ? `Version ${state?.version} is available`
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
    : status === 'ready' || status === 'available' ? 'accent'
    : status === 'current' ? 'ok' : 'plain'
  const icon = working ? <Loader2 size={15} className="animate-spin" aria-hidden />
    : error || status === 'error' ? <AlertCircle size={15} aria-hidden />
    : status === 'ready' ? <ArrowDownToLine size={15} aria-hidden />
    : status === 'available' ? <ExternalLink size={15} aria-hidden />
    : status === 'current' ? <Check size={15} aria-hidden />
    : <RotateCw size={15} aria-hidden />
  const disabled = busy || !state || !status || ['disabled', 'checking', 'downloading', 'installing'].includes(status)
  return <section className="flex flex-col gap-2.5 border-t border-line pt-5" aria-label="App updates">
    <div className="flex items-center justify-between gap-2">
      {/* Same section heading as every other block in Settings: 11px,
          uppercase, 0.08em. It was the one heading in sentence case. */}
      <h3 className="text-[11px] font-medium tracking-[0.08em] text-text-faint uppercase">Updates</h3>
      {state && <span className="rounded-pill border border-line-soft bg-bg-hover px-2 py-0.5 text-[10px] font-medium text-text-faint">{state.currentVersion}</span>}
    </div>
    <div className="flex flex-col gap-3 overflow-hidden rounded-panel border border-line-soft bg-bg-raise p-3.5">
      <div className="flex items-start gap-2.5">
        <span className={`grid h-8 w-8 flex-none place-items-center rounded-pill border ${TONE_CLASS[tone]}`}>{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-[11.5px] font-medium text-text">{headline}</p>
          {detail && <p role="status" aria-live="polite" className="text-[11px] leading-relaxed text-text-faint">{detail}</p>}
        </div>
        {status === 'downloading' && <span className="flex-none text-[11px] font-medium tabular-nums text-text-dim">{percent}%</span>}
      </div>
      {status === 'downloading' && (
        <div role="progressbar" aria-label="Update download" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
          className="h-1.5 w-full overflow-hidden rounded-pill bg-bg-hover">
          <div className="h-full rounded-pill bg-accent transition-[width] duration-300 ease-out" style={{ width: `${percent}%` }} />
        </div>
      )}
      <button type="button"
        className={`flex min-h-[34px] items-center justify-center gap-1.5 self-start rounded-panel px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${
          status === 'ready' || status === 'available' ? 'bg-accent text-bg hover:opacity-90' : 'border border-line-soft text-text hover:bg-bg-hover'
        }`}
        disabled={disabled}
        onClick={() => void act()}>
        {status === 'ready' ? <ArrowDownToLine size={13} aria-hidden />
          : status === 'available' ? <ExternalLink size={13} aria-hidden />
          : <RotateCw size={13} className={working ? 'animate-spin' : ''} aria-hidden />}
        {status === 'ready' ? 'Restart and install' : status === 'available' ? 'Download update' : status === 'error' || error ? 'Try again' : 'Check for updates'}
      </button>
    </div>
    {curtain && <UpdateCurtain percent={curtain.percent} label={`Updating OrcSpace${state?.version ? ` to ${state.version}` : ''}`} />}
  </section>
}
