import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Calendar,
  Clock,
  Copy,
  Cpu,
  GitBranch,
  HardDrive,
  Layers,
  Minus,
  RefreshCw,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import AntigravityIcon from './AntigravityIcon'
import CodexIcon from './CodexIcon'
import ClaudeIcon from './ClaudeIcon'
import GrokIcon from './GrokIcon'
import OpenCodeIcon from './OpenCodeIcon'
import CursorIcon from './CursorIcon'
import type { GitStatus, SystemStats } from '../../../preload/index.d'
import { IS_MAC } from '../lib/platform'

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB'
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

function formatUptime(seconds: number): string {
  if (!seconds) return '0m'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function renderAgentIcon(id: string, size = 13): React.JSX.Element {
  switch (id) {
    case 'antigravity':
      return <AntigravityIcon size={size} />
    case 'codex':
      return <CodexIcon size={size} />
    case 'claude':
      return <ClaudeIcon size={size} />
    case 'grok':
      return <GrokIcon size={size} />
    case 'opencode':
      return <OpenCodeIcon size={size} />
    case 'cursor':
      return <CursorIcon size={size} />
    default:
      return <Activity size={size} className="text-accent" />
  }
}

function shortAgentName(id: string, name: string): string {
  switch (id) {
    case 'antigravity':
      return 'AGY'
    case 'codex':
      return 'CDX'
    case 'claude':
      return 'CLD'
    case 'opencode':
      return 'OpenCode'
    case 'grok':
      return 'Grok'
    default:
      return name.slice(0, 4).toUpperCase()
  }
}

function getPercentColor(percent: number): string {
  if (percent > 80) return 'text-[#f87171]'
  if (percent > 50) return 'text-[#e6c07b]'
  return 'text-[#38bdf8]'
}

function getProgressBg(percent: number): string {
  if (percent > 80) return 'bg-[#f87171]'
  if (percent > 50) return 'bg-[#e6c07b]'
  return 'bg-[#38bdf8]'
}

function getRemainingColor(rem: number): string {
  if (rem < 20) return 'text-[#f87171]'
  if (rem < 50) return 'text-[#e6c07b]'
  return 'text-[#4ade80]'
}

function getRemainingProgressBg(rem: number): string {
  if (rem < 20) return 'bg-[#f87171]'
  if (rem < 50) return 'bg-[#e6c07b]'
  return 'bg-[#4ade80]'
}

function formatTokens(tokens?: number): string {
  if (!tokens || tokens <= 0) return ''
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`
  return `${tokens} tokens`
}

export type WorkView = 'canvas' | 'chat' | 'code'

/**
 * One geometry for the whole bar, declared once so the three islands cannot
 * drift apart: every island is the same height, radius, border and inner
 * padding, and every control inside them is the same 22px tall with the same
 * 6px radius. Changing the bar's scale is a change to these five lines.
 */
const ISLAND =
  'flex h-[34px] items-center gap-[3px] rounded-full border border-[#2a2a2e] bg-[#1c1c1f] p-[3px]'
/** A labelled capsule: icon + text. The border is always there, transparent
 *  when the control is idle, so turning it on cannot nudge the row by a pixel. */
const PILL =
  'flex h-[28px] flex-none items-center gap-1.5 rounded-full border border-transparent px-3 text-[13px] font-medium transition-colors duration-150 cursor-pointer select-none outline-none'
/** An icon-only capsule — the window buttons. */
const ICON =
  'grid h-[28px] w-[32px] flex-none place-items-center rounded-full border border-transparent transition-colors duration-150 cursor-pointer outline-none'
const QUIET = 'text-[#8a8a90] hover:bg-[#232326] hover:text-[#ececec]'
const ON = 'bg-[#2a2a2e] text-[#ececec] border-transparent'

interface Props {
  /** Owned by App: the switcher only reports intent, the surfaces live there. */
  activeView: WorkView
  onViewChange: (view: WorkView) => void
}

// Memoized: App re-renders on every camera frame; the bar's own state (git
// poll, flash, maximized) is what should drive its renders, not the canvas
// moving underneath it. `onViewChange` is a stable useCallback in App.
export default React.memo(function TitleBar({ activeView, onViewChange }: Props): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitOpen, setGitOpen] = useState(false)
  const [usageStats, setUsageStats] = useState<SystemStats | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)
  const rightIslandRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!gitOpen && !usageOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rightIslandRef.current && !rightIslandRef.current.contains(e.target as Node)) {
        setGitOpen(false)
        setUsageOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setGitOpen(false)
        setUsageOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [gitOpen, usageOpen])

  useEffect(() => {
    // On failure the default (restored window) is the safe assumption.
    void window.api.window.isMaximized().then(setMaximized).catch(() => setMaximized(false))
    return window.api.window.onMaximizeChange(setMaximized)
  }, [])

  const gitSeq = useRef(0)
  const gitAbortRef = useRef<AbortController | null>(null)
  const refreshGit = useCallback(async (): Promise<void> => {
    gitAbortRef.current?.abort()
    const ctrl = new AbortController()
    gitAbortRef.current = ctrl
    const seq = ++gitSeq.current
    try {
      const res = (await window.api.git.status()) as GitStatus | { error: string; code?: string }
      if (ctrl.signal.aborted || seq !== gitSeq.current) return
      if (res && !('error' in res)) {
        setGitStatus(res as GitStatus)
      } else {
        const code = (res as { code?: string })?.code
        if (code === 'cancelled') return
        if ((res as { error?: string }).error) {
          setGitStatus(res as unknown as GitStatus)
        } else {
          setGitStatus(null)
        }
      }
    } catch {
      if (ctrl.signal.aborted || seq !== gitSeq.current) return
      setGitStatus(null)
    }
  }, [])

  useEffect(() => {
    void refreshGit()
    let timer: ReturnType<typeof setTimeout>
    let cancelled = false
    const schedule = (): void => {
      if (cancelled) return
      const delay = document.hidden || !document.hasFocus() ? 30_000 : 8_000
      timer = setTimeout(() => {
        if (cancelled) return
        if (!document.hidden) void refreshGit()
        schedule()
      }, delay)
    }
    schedule()
    const onVisible = (): void => {
      if (!document.hidden) void refreshGit()
    }
    const onFocus = (): void => {
      void refreshGit()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    const offDir = window.api.workspace.onDirChange(() => void refreshGit())
    return () => {
      cancelled = true
      clearTimeout(timer)
      gitAbortRef.current?.abort()
      gitSeq.current += 1
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      offDir()
    }
  }, [refreshGit])

  const usageSeqRef = useRef(0)
  const refreshUsage = useCallback(async (): Promise<void> => {
    const seq = ++usageSeqRef.current
    try {
      const res = await window.api.system.stats()
      // A slower poll must not overwrite a newer sample (for example after
      // the window becomes visible again). The sequence also invalidates
      // replies that arrive after this component has unmounted.
      if (seq !== usageSeqRef.current) return
      if (res && !('error' in res)) {
        setUsageStats(res as SystemStats)
        setUsageError(null)
      } else {
        setUsageError((res as { error?: string })?.error || 'Failed to load usage stats')
      }
    } catch (err) {
      if (seq !== usageSeqRef.current) return
      setUsageError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Poll usage every 5 seconds as requested by user
  useEffect(() => {
    void refreshUsage()
    const timer = setInterval(() => {
      if (!document.hidden) void refreshUsage()
    }, 5000)
    const onVisible = (): void => {
      if (!document.hidden) void refreshUsage()
    }
    const onFocus = (): void => {
      void refreshUsage()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      usageSeqRef.current += 1
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshUsage])

  useEffect(() => {
    let timer: number | null = null
    const onFlash = (event: Event): void => {
      const text = (event as CustomEvent<string>).detail
      if (typeof text !== 'string' || !text.trim()) return
      setFlash(text.trim())
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setFlash((current) => (current === text.trim() ? null : current))
        timer = null
      }, 4000)
    }
    window.addEventListener('orcspace:title-flash', onFlash)
    return () => {
      window.removeEventListener('orcspace:title-flash', onFlash)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  const dirtyCount = gitStatus
    ? (gitStatus.modified ?? 0) + (gitStatus.untracked ?? 0) + (gitStatus.staged ?? 0) + (gitStatus.conflicted ?? 0)
    : 0

  const openAgents = (usageStats?.agents || []).filter((a) => a.isOpen)

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  // No `onDoubleClick` here on purpose. The bar is a `-webkit-app-region:
  // drag` caption area, and both platforms already give a caption
  // double-click the native maximize/restore (macOS honours the system
  // "double-click a window's title bar to" preference, Windows treats the
  // region as HTCAPTION). Adding a JS `toggleMaximize()` on top of that fires
  // *after* the native toggle and immediately undoes it.

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-0 z-[50000] flex h-10 items-center px-2 bg-transparent select-none"
      style={
        {
          WebkitAppRegion: 'drag',
          // macOS draws its traffic lights inside this bar (the window is
          // frameless but keeps them). Reserve the gutter they sit in so the
          // left island never lands underneath close/minimise/zoom.
          ...(IS_MAC ? { paddingLeft: 78 } : {})
        } as React.CSSProperties
      }
    >
      {/* Left island: transient status messages only. */}
      <div className="flex h-10 min-w-0 max-w-[340px] flex-none items-center gap-1.5" style={noDrag}>
        {flash && (
          <div role="status" className={`${ISLAND} min-w-0 px-3`}>
            <span className="truncate text-[13px] font-medium text-text">{flash}</span>
          </div>
        )}
      </div>

      {/* Centre island: Canvas / Chat / Code switch the visible surface. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className={`${ISLAND} pointer-events-auto`}
          style={noDrag}
          role="tablist"
          aria-label="Workspace View"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
            e.preventDefault()
            const tabs = Array.from((e.currentTarget as HTMLElement).querySelectorAll('[role="tab"]')) as HTMLElement[]
            if (tabs.length === 0) return
            const idx = tabs.indexOf(document.activeElement as HTMLElement)
            let next = 0
            if (e.key === 'ArrowRight') next = (idx + 1 + tabs.length) % tabs.length
            else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length
            else if (e.key === 'Home') next = 0
            else next = tabs.length - 1
            tabs[next]?.focus()
          }}
        >
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('canvas')}
            aria-selected={activeView === 'canvas'}
            className={`${PILL} ${activeView === 'canvas' ? ON : QUIET}`}
            title="Canvas"
          >
            <span>Canvas</span>
          </button>
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('chat')}
            aria-selected={activeView === 'chat'}
            className={`${PILL} ${activeView === 'chat' ? ON : QUIET}`}
            title="Chat"
          >
            <span>Chat</span>
          </button>
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('code')}
            aria-selected={activeView === 'code'}
            className={`${PILL} ${activeView === 'code' ? ON : QUIET}`}
            title="Code"
          >
            <span>Code</span>
          </button>
        </div>
      </div>

      <div className="flex-1" />

      {/* Right island: Usage, Git, then the window itself. */}
      <div className="flex h-10 flex-none items-center" style={noDrag}>
        <div ref={rightIslandRef} className={`${ISLAND} relative`}>
          {/* Usage button */}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={usageOpen}
            className={`${PILL} ${usageOpen ? ON : QUIET} max-w-[340px]`}
            onClick={() => {
              setUsageOpen((open) => !open)
              setGitOpen(false)
              void refreshUsage()
            }}
            title={
              openAgents.length > 0
                ? `Active AI Agents (${openAgents.map((a) => a.name).join(', ')}):\n` +
                  openAgents
                    .map(
                      (a) =>
                        `• ${a.name}: 5h ${(a.fiveHour.remainingPercent ?? a.fiveHour.percent)}% Remaining (${a.fiveHour.usedPercent ?? 100 - a.fiveHour.percent}% used, ${a.fiveHour.requests} reqs) | Weekly ${(a.weekly.remainingPercent ?? a.weekly.percent)}% Remaining (${a.weekly.resetInfo})`
                    )
                    .join('\n') +
                  (usageStats ? `\n\nCPU: ${usageStats.cpuPercent}% | RAM: ${usageStats.memUsagePercent}%` : '')
                : usageStats
                  ? `Usage (no active AI sessions)\nCPU: ${usageStats.cpuPercent}% | RAM: ${usageStats.memUsagePercent}%\n${usageStats.terminalsCount} active terminal${usageStats.terminalsCount === 1 ? '' : 's'}`
                  : 'System & AI Usage'
            }
          >
            {openAgents.length > 0 ? (
              <div className="flex items-center gap-1.5 min-w-0">
                {openAgents.slice(0, 2).map((ag, idx) => {
                  const rem5h = ag.fiveHour.remainingPercent ?? ag.fiveHour.percent
                  const remWk = ag.weekly.remainingPercent ?? ag.weekly.percent
                  return (
                    <span key={ag.id} className="flex items-center gap-1 min-w-0">
                      {idx > 0 && <span className="text-line-soft font-light">|</span>}
                      <span className="flex-none">{renderAgentIcon(ag.id, 13)}</span>
                      <span className="text-[11px] font-semibold tracking-tight text-text">
                        {shortAgentName(ag.id, ag.name)}
                      </span>
                      <span className="text-[10px] text-text-dim">5h:</span>
                      <span className={`text-[11px] font-semibold tabular-nums ${getRemainingColor(rem5h)}`}>
                        {typeof rem5h === 'number' && Number.isInteger(rem5h) ? `${rem5h}%` : `${Number(rem5h).toFixed(1)}%`}
                      </span>
                      <span className="text-[10px] text-text-dim">Wk:</span>
                      <span className={`text-[11px] font-semibold tabular-nums ${getRemainingColor(remWk)}`}>
                        {typeof remWk === 'number' && Number.isInteger(remWk) ? `${remWk}%` : `${Number(remWk).toFixed(1)}%`}
                      </span>
                    </span>
                  )
                })}
                {openAgents.length > 2 && (
                  <span className="rounded bg-bg-raise px-1 text-[10px] font-semibold text-text-dim">
                    +{openAgents.length - 2}
                  </span>
                )}
                <span className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-400 animate-pulse ml-0.5" title="Live 5s updates" />
              </div>
            ) : (
              <>
                <Activity
                  size={14}
                  className={`flex-none ${
                    usageStats && usageStats.cpuPercent > 80
                      ? 'text-danger'
                      : usageStats && usageStats.cpuPercent > 50
                        ? 'text-[#e6c07b]'
                        : 'text-text-dim'
                  }`}
                />
                <span className="truncate hidden lg:inline">Usage</span>
              </>
            )}
          </button>

          {usageOpen && (
            <div className="absolute right-2 top-[38px] z-[60000] w-[370px] max-h-[82vh] overflow-y-auto rounded-[12px] border border-line-soft bg-bg-panel p-3 text-left shadow-2xl">
              <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-line-soft pb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-text">AI & Resource Usage</span>
                  <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                    <span className="h-1 w-1 rounded-full bg-emerald-400 animate-pulse" />
                    5s
                  </span>
                </div>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-dim hover:bg-bg-hover hover:text-text transition-colors"
                  onClick={() => void refreshUsage()}
                  title="Refresh stats now"
                >
                  <RefreshCw size={11} />
                  Refresh
                </button>
              </div>

              {!usageStats ? (
                usageError ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-[12px] text-danger">{usageError}</p>
                    <div>
                      <button
                        type="button"
                        className="rounded-md border border-line-soft px-2 py-1 text-[11px] text-text-dim hover:bg-bg-hover hover:text-text"
                        onClick={() => void refreshUsage()}
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[12px] text-text-dim">Loading usage stats…</p>
                )
              ) : (
                <div className="space-y-3 text-[12px]">
                  {/* Active AI Sessions Section */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[11px]">
                      <span className="flex items-center gap-1 font-semibold text-text">
                        <Sparkles size={12} className="text-accent" />
                        Active AI Agents ({openAgents.length})
                      </span>
                      {openAgents.length > 0 ? (
                        <span className="text-[10px] text-emerald-400 font-medium flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          Live Quota Sync
                        </span>
                      ) : (
                        <span className="text-[10px] text-text-faint">0 active</span>
                      )}
                    </div>

                    {openAgents.length === 0 ? (
                      <div className="space-y-2">
                        <div className="rounded-[8px] border border-line-soft/60 bg-bg-hover p-2 text-center text-[11px] text-text-dim">
                          No active AI sessions detected. Showing recent CLI agent limits:
                        </div>
                        {(usageStats.agents || []).slice(0, 2).map((ag) => {
                          const rem5h = ag.fiveHour.remainingPercent ?? ag.fiveHour.percent
                          const remWk = ag.weekly.remainingPercent ?? ag.weekly.percent
                          const remMo = ag.monthly ? (ag.monthly.remainingPercent ?? ag.monthly.percent) : null
                          return (
                            <div
                              key={ag.id}
                              className="rounded-[8px] border border-line-soft/60 bg-bg-hover p-2 space-y-1.5 opacity-80"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="grid h-5 w-5 flex-none place-items-center rounded bg-bg-hover/60">
                                    {renderAgentIcon(ag.id, 12)}
                                  </span>
                                  <span className="font-semibold text-text truncate text-xs">{ag.name}</span>
                                </div>
                                <span className="rounded-full border border-line-soft bg-bg-hover/40 px-1.5 py-0.5 text-[9px] text-text-dim">
                                  Idle
                                </span>
                              </div>
                              {/* 5-Hour */}
                              <div className="space-y-1 rounded bg-bg-hover p-1.5 border border-line-soft text-[10px]">
                                <div className="flex justify-between">
                                  <span className="text-text-dim flex items-center gap-1"><Clock size={10} className="text-[#38bdf8]" /> 5h Remaining:</span>
                                  <span className={`font-semibold tabular-nums ${getRemainingColor(rem5h)}`}>
                                    {typeof rem5h === 'number' && Number.isInteger(rem5h) ? `${rem5h}%` : `${Number(rem5h).toFixed(1)}%`}
                                  </span>
                                </div>
                                <div className="h-1 w-full overflow-hidden rounded-full bg-line-soft">
                                  <div className={`h-full ${getRemainingProgressBg(rem5h)}`} style={{ width: `${Math.min(100, Math.max(rem5h > 0 ? 3 : 0, rem5h))}%` }} />
                                </div>
                                <div className="flex justify-between text-[9px] text-text-faint">
                                  <span>{ag.fiveHour.usedPercent ?? (100 - rem5h)}% used ({ag.fiveHour.requests} reqs)</span>
                                  <span>{ag.fiveHour.resetInfo}</span>
                                </div>
                              </div>
                              {/* Weekly */}
                              <div className="space-y-1 rounded bg-bg-hover p-1.5 border border-line-soft text-[10px]">
                                <div className="flex justify-between">
                                  <span className="text-text-dim flex items-center gap-1"><Calendar size={10} className="text-[#7fd99a]" /> Weekly Remaining:</span>
                                  <span className={`font-semibold tabular-nums ${getRemainingColor(remWk)}`}>
                                    {typeof remWk === 'number' && Number.isInteger(remWk) ? `${remWk}%` : `${Number(remWk).toFixed(1)}%`}
                                  </span>
                                </div>
                                <div className="h-1 w-full overflow-hidden rounded-full bg-line-soft">
                                  <div className={`h-full ${getRemainingProgressBg(remWk)}`} style={{ width: `${Math.min(100, Math.max(remWk > 0 ? 3 : 0, remWk))}%` }} />
                                </div>
                                <div className="flex justify-between text-[9px] text-text-faint">
                                  <span>{ag.weekly.usedPercent ?? (100 - remWk)}% used ({ag.weekly.requests} reqs)</span>
                                  <span>{ag.weekly.resetInfo}</span>
                                </div>
                              </div>
                              {/* Monthly */}
                              {ag.monthly && remMo !== null && (
                                <div className="space-y-1 rounded bg-bg-hover p-1.5 border border-line-soft text-[10px]">
                                  <div className="flex justify-between">
                                    <span className="text-text-dim flex items-center gap-1"><Layers size={10} className="text-[#a78bfa]" /> Monthly Remaining:</span>
                                    <span className={`font-semibold tabular-nums ${getRemainingColor(remMo)}`}>
                                      {typeof remMo === 'number' && Number.isInteger(remMo) ? `${remMo}%` : `${Number(remMo).toFixed(1)}%`}
                                    </span>
                                  </div>
                                  <div className="h-1 w-full overflow-hidden rounded-full bg-line-soft">
                                    <div className={`h-full ${getRemainingProgressBg(remMo)}`} style={{ width: `${Math.min(100, Math.max(remMo > 0 ? 3 : 0, remMo))}%` }} />
                                  </div>
                                  <div className="flex justify-between text-[9px] text-text-faint">
                                    <span>{ag.monthly.usedPercent ?? (100 - remMo)}% used ({ag.monthly.requests} reqs)</span>
                                    <span>{ag.monthly.resetInfo}</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {openAgents.map((ag) => {
                          const rem5h = ag.fiveHour.remainingPercent ?? ag.fiveHour.percent
                          const remWk = ag.weekly.remainingPercent ?? ag.weekly.percent
                          const remMo = ag.monthly ? (ag.monthly.remainingPercent ?? ag.monthly.percent) : null
                          const used5h = ag.fiveHour.usedPercent ?? parseFloat((100 - rem5h).toFixed(1))
                          const usedWk = ag.weekly.usedPercent ?? parseFloat((100 - remWk).toFixed(1))
                          const usedMo = ag.monthly ? (ag.monthly.usedPercent ?? parseFloat((100 - (remMo ?? 0)).toFixed(1))) : null

                          return (
                            <div
                              key={ag.id}
                              className="rounded-[8px] border border-line-soft/80 bg-bg-hover p-2.5 space-y-2.5 transition-colors hover:border-line"
                            >
                              {/* Agent Header */}
                              <div>
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="grid h-5 w-5 flex-none place-items-center rounded bg-bg-hover/60">
                                      {renderAgentIcon(ag.id, 13)}
                                    </span>
                                    <span className="font-semibold text-text truncate">{ag.name}</span>
                                    <span className="text-[10px] text-text-faint font-mono">{ag.command}</span>
                                  </div>
                                  <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                                    <span className="h-1 w-1 rounded-full bg-emerald-400" />
                                    {ag.openCount > 1 ? `${ag.openCount} open` : 'Open'}
                                  </span>
                                </div>
                                {(ag.modelName || ag.accountEmail || ag.tierName) && (
                                  <div className="mt-1 flex items-center gap-2 truncate text-[10px] text-text-dim">
                                    {ag.modelName && (
                                      <span className="truncate font-medium text-accent">{ag.modelName}</span>
                                    )}
                                    {ag.accountEmail && (
                                      <span className="truncate text-text-faint">({ag.accountEmail})</span>
                                    )}
                                    {ag.tierName && (
                                      <span className="rounded bg-bg-hover px-1 py-0.5 text-[9px] text-text-dim">{ag.tierName}</span>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* 5-Hour Limit Remaining */}
                              <div className="space-y-1 rounded bg-bg-hover p-2 border border-line-soft">
                                <div className="flex items-center justify-between text-[11px]">
                                  <span className="flex items-center gap-1 text-text font-medium">
                                    <Clock size={11} className="text-[#38bdf8]" />
                                    Five Hour Limit Remaining (Осталось)
                                  </span>
                                  <span className={`font-semibold tabular-nums ${getRemainingColor(rem5h)}`}>
                                    {typeof rem5h === 'number' && Number.isInteger(rem5h) ? `${rem5h}%` : `${Number(rem5h).toFixed(2)}%`}
                                  </span>
                                </div>
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
                                  <div
                                    className={`h-full transition-all duration-300 ${getRemainingProgressBg(rem5h)}`}
                                    style={{ width: `${Math.min(100, Math.max(rem5h > 0 ? 3 : 0, rem5h))}%` }}
                                  />
                                </div>
                                <div className="flex items-center justify-between text-[10px] text-text-faint">
                                  <span>{used5h}% used · {ag.fiveHour.requests} reqs{ag.fiveHour.tokens ? ` (${formatTokens(ag.fiveHour.tokens)})` : ''}</span>
                                  <span className="text-text-dim font-medium">{ag.fiveHour.resetInfo}</span>
                                </div>
                              </div>

                              {/* Weekly Limit Remaining */}
                              <div className="space-y-1 rounded bg-bg-hover p-2 border border-line-soft">
                                <div className="flex items-center justify-between text-[11px]">
                                  <span className="flex items-center gap-1 text-text font-medium">
                                    <Calendar size={11} className="text-[#7fd99a]" />
                                    Weekly Limit Remaining (Осталось)
                                  </span>
                                  <span className={`font-semibold tabular-nums ${getRemainingColor(remWk)}`}>
                                    {typeof remWk === 'number' && Number.isInteger(remWk) ? `${remWk}%` : `${Number(remWk).toFixed(2)}%`}
                                  </span>
                                </div>
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
                                  <div
                                    className={`h-full transition-all duration-300 ${getRemainingProgressBg(remWk)}`}
                                    style={{ width: `${Math.min(100, Math.max(remWk > 0 ? 3 : 0, remWk))}%` }}
                                  />
                                </div>
                                <div className="flex items-center justify-between text-[10px] text-text-faint">
                                  <span>{usedWk}% used · {ag.weekly.requests} reqs{ag.weekly.tokens ? ` (${formatTokens(ag.weekly.tokens)})` : ''}</span>
                                  <span className="text-text-dim font-medium">{ag.weekly.resetInfo}</span>
                                </div>
                              </div>

                              {/* Monthly Limit Remaining */}
                              {ag.monthly && remMo !== null && (
                                <div className="space-y-1 rounded bg-bg-hover p-2 border border-line-soft">
                                  <div className="flex items-center justify-between text-[11px]">
                                    <span className="flex items-center gap-1 text-text font-medium">
                                      <Layers size={11} className="text-[#a78bfa]" />
                                      Monthly Limit Remaining (Месячный / 30д)
                                    </span>
                                    <span className={`font-semibold tabular-nums ${getRemainingColor(remMo)}`}>
                                      {typeof remMo === 'number' && Number.isInteger(remMo) ? `${remMo}%` : `${Number(remMo).toFixed(2)}%`}
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
                                    <div
                                      className={`h-full transition-all duration-300 ${getRemainingProgressBg(remMo)}`}
                                      style={{ width: `${Math.min(100, Math.max(remMo > 0 ? 3 : 0, remMo))}%` }}
                                    />
                                  </div>
                                  <div className="flex items-center justify-between text-[10px] text-text-faint">
                                    <span>{usedMo}% used · {ag.monthly.requests} reqs{ag.monthly.tokens ? ` (${formatTokens(ag.monthly.tokens)})` : ''}</span>
                                    <span className="text-text-dim font-medium">{ag.monthly.resetInfo}</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* System Resources Section */}
                  <div className="border-t border-line-soft pt-2">
                    <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold text-text">
                      <Activity size={12} className="text-accent" />
                      System Resources
                    </div>

                    <div className="space-y-2 text-[11px]">
                      {/* CPU */}
                      <div className="rounded-[8px] border border-line-soft/60 bg-bg-hover p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="flex items-center gap-1 text-text-dim">
                            <Cpu size={11} className="text-[#7aa2f7]" />
                            CPU Load ({usageStats.cpuCount} cores)
                          </span>
                          <span className="font-semibold tabular-nums text-text">{usageStats.cpuPercent}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
                          <div
                            className={`h-full transition-all duration-300 ${
                              usageStats.cpuPercent > 80
                                ? 'bg-danger'
                                : usageStats.cpuPercent > 50
                                  ? 'bg-[#e6c07b]'
                                  : 'bg-[#7aa2f7]'
                            }`}
                            style={{ width: `${Math.min(100, Math.max(2, usageStats.cpuPercent))}%` }}
                          />
                        </div>
                        {usageStats.cpuModel && (
                          <div className="mt-1 truncate text-[10px] text-text-faint" title={usageStats.cpuModel}>
                            {usageStats.cpuModel}
                          </div>
                        )}
                      </div>

                      {/* RAM */}
                      <div className="rounded-[8px] border border-line-soft/60 bg-bg-hover p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="flex items-center gap-1 text-text-dim">
                            <HardDrive size={11} className="text-[#7fd99a]" />
                            RAM Usage
                          </span>
                          <span className="font-semibold tabular-nums text-text">{usageStats.memUsagePercent}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
                          <div
                            className={`h-full transition-all duration-300 ${
                              usageStats.memUsagePercent > 85
                                ? 'bg-danger'
                                : usageStats.memUsagePercent > 65
                                  ? 'bg-[#e6c07b]'
                                  : 'bg-[#7fd99a]'
                            }`}
                            style={{ width: `${Math.min(100, Math.max(2, usageStats.memUsagePercent))}%` }}
                          />
                        </div>
                        <div className="mt-1 flex justify-between text-[10px] text-text-dim">
                          <span>Used / Total:</span>
                          <span className="font-medium text-text tabular-nums">
                            {formatBytes(usageStats.usedMem)} / {formatBytes(usageStats.totalMem)}
                          </span>
                        </div>
                      </div>

                      {/* Terminals & Uptime */}
                      <div className="flex justify-between text-[10px] text-text-dim px-0.5">
                        <span>Active Terminals: <span className="text-accent font-medium">{usageStats.terminalsCount}</span></span>
                        <span>Uptime: <span className="text-text font-medium">{formatUptime(usageStats.uptime)}</span></span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Git button */}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={gitOpen}
            className={`${PILL} ${gitOpen ? ON : QUIET}`}
            onClick={() => {
              setGitOpen((open) => !open)
              setUsageOpen(false)
              void refreshGit()
            }}
            title={
              gitStatus?.repo
                ? `Git (${gitStatus.branch || 'HEAD'})\n${dirtyCount > 0 ? `${dirtyCount} changed file${dirtyCount > 1 ? 's' : ''}` : 'Working tree clean'}`
                : 'Git — not a repository'
            }
          >
            <GitBranch
              size={14}
              className={`flex-none ${gitStatus?.repo ? (dirtyCount > 0 ? 'text-accent' : 'text-text-dim') : 'text-text-faint'}`}
            />
            {/* The branch name is the widest thing on the bar; past this width the
                right island would run into the centred view switcher (the OS-level
                minWidth is 800). The icon + dirty dot still carry the state. */}
            <span className="hidden min-[1000px]:inline max-w-[110px] truncate">
              {gitStatus?.repo ? gitStatus.branch || 'HEAD' : 'Git'}
            </span>
            {dirtyCount > 0 && <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />}
          </button>

          {gitOpen && (
            <div className="absolute right-2 top-[38px] z-[60000] w-[310px] rounded-[12px] border border-line-soft bg-bg-panel p-3 text-left shadow-2xl">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold text-text">Git status</span>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-text-dim hover:bg-bg-hover hover:text-text"
                  onClick={() => void refreshGit()}
                >
                  Refresh
                </button>
              </div>
              {!gitStatus ? (
                <p className="text-[12px] text-text-dim">Checking repository…</p>
              ) : !gitStatus.repo ? (
                <div className="space-y-1 text-[12px]">
                  <p className="text-text-dim">This workspace is not a Git repository.</p>
                  {gitStatus.error && <p className="break-words text-accent">{gitStatus.error}</p>}
                </div>
              ) : (
                <div className="space-y-2 text-[12px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium text-text">{gitStatus.branch || 'HEAD'}</span>
                    <span className="flex-none text-text-dim">{dirtyCount ? `${dirtyCount} changed` : 'clean'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-text-dim">
                    <span>Modified: {gitStatus.modified}</span>
                    <span>Untracked: {gitStatus.untracked}</span>
                    <span>Staged: {gitStatus.staged}</span>
                    <span>Conflicts: {gitStatus.conflicted}</span>
                    <span>Ahead: {gitStatus.ahead}</span>
                    <span>Behind: {gitStatus.behind}</span>
                  </div>
                  {gitStatus.lastCommit && (
                    <div className="border-t border-line-soft pt-2">
                      <div className="text-[11px] text-text-faint">Last commit · {gitStatus.lastCommit.hash}</div>
                      <div className="truncate text-text" title={gitStatus.lastCommit.subject}>{gitStatus.lastCommit.subject}</div>
                    </div>
                  )}
                  <div className="truncate border-t border-line-soft pt-2 text-[10px] text-text-faint" title={gitStatus.root}>
                    {gitStatus.root}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* macOS renders its own traffic lights at the far left of this bar,
              so a second set of window buttons on the right is both redundant
              and non-native. Windows and Linux keep them — the frame is off and
              they are the only way to minimise, maximise or close. */}
          {!IS_MAC && (
            <>
              <span className="mx-0.5 h-4 w-px flex-none bg-line-soft/80" />

              <button
                className={`${ICON} ${QUIET}`}
                title="Minimize"
                aria-label="Minimize"
                onClick={() => void Promise.resolve(window.api.window.minimize()).catch(() => {})}
              >
                <Minus size={14} strokeWidth={2.2} />
              </button>
              <button
                className={`${ICON} ${QUIET}`}
                title={maximized ? 'Restore' : 'Maximize'}
                aria-label={maximized ? 'Restore' : 'Maximize'}
                onClick={() => void Promise.resolve(window.api.window.toggleMaximize()).catch(() => {})}
              >
                {maximized ? <Copy size={13} strokeWidth={2} /> : <Square size={13} strokeWidth={2} />}
              </button>
              <button
                className={`${ICON} text-text-dim hover:bg-bg-hover hover:text-text`}
                title="Close"
                aria-label="Close"
                onClick={() => void Promise.resolve(window.api.window.close()).catch(() => {})}
              >
                <X size={14} strokeWidth={2.2} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
})
