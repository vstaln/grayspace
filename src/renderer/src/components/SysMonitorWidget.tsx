import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Calendar,
  ChevronDown,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Server,
  Sparkles,
  Terminal,
  Trash2,
  Zap
} from 'lucide-react'
import AntigravityIcon from './AntigravityIcon'
import CodexIcon from './CodexIcon'
import ClaudeIcon from './ClaudeIcon'
import GrokIcon from './GrokIcon'
import OpenCodeIcon from './OpenCodeIcon'
import CursorIcon from './CursorIcon'
import KimiIcon from './KimiIcon'
import type { SystemStats } from '../../../preload/index.d'
import { useConfirm } from './ConfirmDialog'

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
    case 'kimi':
      return <KimiIcon size={size} />
    case 'cursor':
      return <CursorIcon size={size} />
    default:
      return <Activity size={size} className="text-accent" />
  }
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

export default React.memo(function SysMonitorWidget(): React.JSX.Element {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [paused, setPaused] = useState(false)
  const [cpuHistory, setCpuHistory] = useState<number[]>(() => new Array(25).fill(0))
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshInterval, setRefreshInterval] = useState<number>(5000)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalMenuRef = useRef<HTMLDivElement>(null)
  const [intervalMenuOpen, setIntervalMenuOpen] = useState(false)




  const rootRef = useRef<HTMLDivElement>(null)
  const statsSeqRef = useRef(0)
  const confirm = useConfirm()

  const showNotice = useCallback((msg: string): void => {
    setNotice(msg)
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, 3000)
  }, [])

  const fetchStats = useCallback(async (): Promise<void> => {
    const seq = ++statsSeqRef.current
    setLoading(true)
    try {
      const res = await window.api.system.stats()
      if (seq !== statsSeqRef.current) return
      if ('error' in res && res.error) {
        showNotice(res.error)
      } else {
        const s = res as SystemStats
        setStats(s)
        setCpuHistory((prev) => {
          const next = [...prev.slice(1), s.cpuPercent]
          return next
        })
      }
    } catch (err) {
      if (seq !== statsSeqRef.current) return
      showNotice(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === statsSeqRef.current) setLoading(false)
    }
  }, [showNotice])

  useEffect(() => {
    void fetchStats()
    if (paused) return
    const interval = setInterval(() => {


      if (!document.hidden && rootRef.current?.offsetParent) void fetchStats()
    }, refreshInterval)
    const onVisible = (): void => {
      if (!document.hidden) void fetchStats()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      statsSeqRef.current += 1
      document.removeEventListener('visibilitychange', onVisible)
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [paused, refreshInterval, fetchStats])

  useEffect(() => {
    if (!intervalMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!intervalMenuRef.current?.contains(event.target as Node)) setIntervalMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [intervalMenuOpen])

  const handleReleaseLocks = async (): Promise<void> => {
    const ok = await confirm('Release all file locks?', {
      danger: true,
      title: 'Release locks',
      confirmLabel: 'Release'
    })
    if (!ok) return
    try {
      const result = await window.api.system.releaseLocks()
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        showNotice(`Failed to release locks: ${String(result.error)}`)
        return
      }
      showNotice('All resource locks released')
    } catch {
      showNotice('Failed to release locks')
    }
  }

  const handleKillTerminal = async (id: string, title: string): Promise<void> => {
    const ok = await confirm(`Close terminal “${title}”? The process will be killed.`, {
      danger: true,
      title: 'Close terminal',
      confirmLabel: 'Close'
    })
    if (!ok) return
    try {
      const result = await window.api.terminal.dispose(id)
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        showNotice(`Failed to close ${title}: ${String(result.error)}`)
        return
      }
      showNotice(`Closed ${title}`)
      void fetchStats()
    } catch {
      showNotice(`Failed to close ${title}`)
    }
  }

  const cpuPercent = stats?.cpuPercent ?? 0
  const memPercent = stats?.memUsagePercent ?? 0

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-bg-panel text-text"
      data-canvas-scroll-lock="true"
      onWheel={(e) => e.stopPropagation()}
    >
      {}
      <div className="flex flex-none items-center justify-between border-b border-line-soft px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-text">
          <Activity size={14} className="text-accent" />
          <span>System & Resource Monitor</span>
        </div>

        <div className="flex items-center gap-1">
          <div className="relative" ref={intervalMenuRef}>
            <button
              className="flex h-7 items-center gap-1 rounded-panel border border-line-soft bg-bg-hover/35 px-2 text-[10px] text-text-dim outline-none transition-colors hover:border-line hover:bg-bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent/60"
              onClick={() => setIntervalMenuOpen((open) => !open)}
              title="Refresh interval"
              aria-label="Refresh interval"
              aria-haspopup="menu"
              aria-expanded={intervalMenuOpen}
            >
              <span>{refreshInterval / 1000}s</span>
              <ChevronDown size={11} className={intervalMenuOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
            {intervalMenuOpen && (
              <div
                role="menu"
                aria-label="Refresh interval"
                className="absolute top-[calc(100%+4px)] right-0 z-20 min-w-[64px] overflow-hidden rounded-panel border border-line-soft bg-bg-panel py-1 shadow-lg"
              >
                {[1000, 2000, 5000].map((value) => (
                  <button
                    key={value}
                    role="menuitemradio"
                    aria-checked={refreshInterval === value}
                    className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[10px] outline-none transition-colors hover:bg-bg-hover ${
                      refreshInterval === value ? 'text-accent' : 'text-text-dim'
                    }`}
                    onClick={() => {
                      setRefreshInterval(value)
                      setIntervalMenuOpen(false)
                    }}
                  >
                    {value / 1000}s
                    {refreshInterval === value && <span className="ml-2 h-1.5 w-1.5 rounded-pill bg-accent" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className={`grid h-7 w-7 place-items-center rounded-panel border border-line-soft transition-colors ${
              paused
                ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                : 'bg-bg-hover/35 text-text-dim hover:border-line hover:bg-bg-hover hover:text-text'
            }`}
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Resume monitoring' : 'Pause monitoring'}
            aria-label="Pause or resume"
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </button>

          <button
            className="grid h-7 w-7 place-items-center rounded-pill border border-line-soft bg-bg-hover/35 text-text-dim transition-colors hover:border-line hover:bg-bg-hover hover:text-text"
            onClick={() => void fetchStats()}
            title="Refresh now"
            aria-label="Refresh stats"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex-none border-b border-accent/30 bg-accent/10 px-3 py-1 text-[11px] text-accent">
          {notice}
        </div>
      )}

      {}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3.5">
        {}
        {stats?.agents && stats.agents.length > 0 && (
          <div className="rounded-panel border border-line-soft bg-bg-hover/20 p-2.5 space-y-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-text">
              <span className="flex items-center gap-1.5">
                <Sparkles size={13} className="text-accent" />
                AI Agent Usage & Limits
              </span>
              <span className="text-[10px] font-normal text-emerald-400">
                {stats.agents.filter((a) => a.isOpen).length} Active
              </span>
            </div>

            {

}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
              {stats.agents
                .filter((a) => a.isOpen || a.fiveHour.requests > 0 || a.weekly.requests > 0)
                .map((ag) => {
                  const rem5h = ag.fiveHour.remainingPercent ?? ag.fiveHour.percent
                  const remWk = ag.weekly.remainingPercent ?? ag.weekly.percent
                  const remMo = ag.monthly ? (ag.monthly.remainingPercent ?? ag.monthly.percent) : null
                  const used5h = ag.fiveHour.usedPercent ?? parseFloat((100 - rem5h).toFixed(1))
                  const usedWk = ag.weekly.usedPercent ?? parseFloat((100 - remWk).toFixed(1))
                  const usedMo = ag.monthly ? (ag.monthly.usedPercent ?? parseFloat((100 - (remMo ?? 0)).toFixed(1))) : null

                  return (
                    <div
                      key={ag.id}
                      className="rounded-panel border border-line-soft/80 bg-bg-hover p-2 space-y-2"
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="grid h-5 w-5 flex-none place-items-center rounded-pill bg-bg-hover/60">
                              {renderAgentIcon(ag.id, 13)}
                            </span>
                            <span className="font-semibold text-text truncate text-xs">{ag.name}</span>
                          </div>
                          <span
                            className={`flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-[10px] font-medium border ${
                              ag.isOpen
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : 'border-line-soft bg-bg-hover/40 text-text-dim'
                            }`}
                          >
                            {ag.isOpen && <span className="h-1 w-1 rounded-pill bg-emerald-400" />}
                            {ag.isOpen ? `${ag.openCount > 1 ? `${ag.openCount} ` : ''}Active` : 'Idle'}
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
                              <span className="rounded-panel bg-bg-hover px-1 py-0.5 text-[9px] text-text-dim">{ag.tierName}</span>
                            )}
                          </div>
                        )}
                      </div>

                      {}
                      <div className="space-y-1 rounded-panel bg-bg-hover p-1.5 border border-line-soft">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="flex items-center gap-1 text-text font-medium">
                            <Clock size={10} className="text-[#38bdf8]" /> 5h Remaining (Осталось)
                          </span>
                          <span className={`font-semibold tabular-nums ${getRemainingColor(rem5h)}`}>
                            {typeof rem5h === 'number' && Number.isInteger(rem5h) ? `${rem5h}%` : `${Number(rem5h).toFixed(2)}%`}
                          </span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-pill bg-line-soft">
                          <div
                            className={`h-full transition-all duration-300 ${getRemainingProgressBg(rem5h)}`}
                            style={{ width: `${Math.min(100, Math.max(rem5h > 0 ? 3 : 0, rem5h))}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[9px] text-text-faint">
                          <span>{used5h}% used · {ag.fiveHour.requests} reqs{ag.fiveHour.tokens ? ` (${formatTokens(ag.fiveHour.tokens)})` : ''}</span>
                          <span className="text-text-dim">{ag.fiveHour.resetInfo}</span>
                        </div>
                      </div>

                      {}
                      <div className="space-y-1 rounded-panel bg-bg-hover p-1.5 border border-line-soft">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="flex items-center gap-1 text-text font-medium">
                            <Calendar size={10} className="text-[#7fd99a]" /> Weekly Remaining (Осталось)
                          </span>
                          <span className={`font-semibold tabular-nums ${getRemainingColor(remWk)}`}>
                            {typeof remWk === 'number' && Number.isInteger(remWk) ? `${remWk}%` : `${Number(remWk).toFixed(2)}%`}
                          </span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-pill bg-line-soft">
                          <div
                            className={`h-full transition-all duration-300 ${getRemainingProgressBg(remWk)}`}
                            style={{ width: `${Math.min(100, Math.max(remWk > 0 ? 3 : 0, remWk))}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[9px] text-text-faint">
                          <span>{usedWk}% used · {ag.weekly.requests} reqs{ag.weekly.tokens ? ` (${formatTokens(ag.weekly.tokens)})` : ''}</span>
                          <span className="text-text-dim">{ag.weekly.resetInfo}</span>
                        </div>
                      </div>

                      {}
                      {ag.monthly && remMo !== null && (
                        <div className="space-y-1 rounded-panel bg-bg-hover p-1.5 border border-line-soft">
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="flex items-center gap-1 text-text font-medium">
                              <Layers size={10} className="text-[#a78bfa]" /> Monthly Remaining (Месячный)
                            </span>
                            <span className={`font-semibold tabular-nums ${getRemainingColor(remMo)}`}>
                              {typeof remMo === 'number' && Number.isInteger(remMo) ? `${remMo}%` : `${Number(remMo).toFixed(2)}%`}
                            </span>
                          </div>
                          <div className="h-1 w-full overflow-hidden rounded-pill bg-line-soft">
                            <div
                              className={`h-full transition-all duration-300 ${getRemainingProgressBg(remMo)}`}
                              style={{ width: `${Math.min(100, Math.max(remMo > 0 ? 3 : 0, remMo))}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[9px] text-text-faint">
                            <span>{usedMo}% used · {ag.monthly.requests} reqs{ag.monthly.tokens ? ` (${formatTokens(ag.monthly.tokens)})` : ''}</span>
                            <span className="text-text-dim">{ag.monthly.resetInfo}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          </div>
        )}

        {}
        <div className="grid grid-cols-2 gap-2.5">
          {}
          <div className="rounded-panel border border-line-soft bg-bg-hover/20 p-2.5">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 text-text-dim">
                <Cpu size={13} className="text-[#7aa2f7]" /> CPU Load
              </span>
              <span className="font-semibold tabular-nums text-text">{cpuPercent}%</span>
            </div>

            {}
            <div className="mb-2 h-1.5 w-full overflow-hidden rounded-pill bg-line-soft">
              <div
                className={`h-full transition-all duration-300 ${
                  cpuPercent > 80 ? 'bg-danger' : cpuPercent > 50 ? 'bg-[#e6c07b]' : 'bg-[#7aa2f7]'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, cpuPercent))}%` }}
              />
            </div>

            {}
            <div className="flex h-9 items-end gap-[2px] rounded-panel bg-bg-hover px-1 py-0.5">
              {cpuHistory.map((val, i) => (
                <div
                  key={i}
                  className={`flex-1 rounded-t-panel transition-all duration-300 ${
                    val > 80 ? 'bg-danger' : val > 50 ? 'bg-[#e6c07b]' : 'bg-[#7aa2f7]'
                  }`}
                  style={{ height: `${Math.max(4, (val / 100) * 32)}px` }}
                  title={`${val}%`}
                />
              ))}
            </div>

            <div className="mt-1.5 truncate text-[10px] text-text-faint" title={stats?.cpuModel}>
              {stats ? `${stats.cpuCount} cores · ${stats.cpuModel}` : 'Loading…'}
            </div>
          </div>

          {}
          <div className="rounded-panel border border-line-soft bg-bg-hover/20 p-2.5">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 text-text-dim">
                <HardDrive size={13} className="text-[#7fd99a]" /> RAM Usage
              </span>
              <span className="font-semibold tabular-nums text-text">{memPercent}%</span>
            </div>

            {}
            <div className="mb-2 h-1.5 w-full overflow-hidden rounded-pill bg-line-soft">
              <div
                className={`h-full transition-all duration-300 ${
                  memPercent > 85 ? 'bg-danger' : memPercent > 65 ? 'bg-[#e6c07b]' : 'bg-[#7fd99a]'
                }`}
                style={{ width: `${Math.min(100, Math.max(2, memPercent))}%` }}
              />
            </div>

            <div className="space-y-1 text-[11px] tabular-nums">
              <div className="flex justify-between text-text-dim">
                <span>Used / Total:</span>
                <span className="text-text font-medium">
                  {stats ? `${formatBytes(stats.usedMem)} / ${formatBytes(stats.totalMem)}` : '—'}
                </span>
              </div>
              <div className="flex justify-between text-text-dim">
                <span>App Memory (RSS):</span>
                <span className="text-text font-medium">
                  {stats?.processMemory ? formatBytes(stats.processMemory.rss) : '—'}
                </span>
              </div>
              <div className="flex justify-between text-text-dim">
                <span>Heap:</span>
                <span className="text-text-faint">
                  {stats?.processMemory ? `${formatBytes(stats.processMemory.heapUsed)} / ${formatBytes(stats.processMemory.heapTotal)}` : '—'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {}
        <div className="rounded-panel border border-line-soft bg-bg-hover/20 p-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text">
            <Server size={13} className="text-accent" /> Host & Runtime
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            <div className="flex justify-between text-text-dim">
              <span>Platform:</span>
              <span className="font-medium text-text">{stats ? `${stats.platform} (${stats.arch})` : '—'}</span>
            </div>
            <div className="flex justify-between text-text-dim">
              <span>Hostname:</span>
              <span className="font-medium text-text truncate max-w-[110px]" title={stats?.hostname}>{stats?.hostname || '—'}</span>
            </div>
            <div className="flex justify-between text-text-dim">
              <span>System Uptime:</span>
              <span className="font-medium text-text tabular-nums">{stats ? formatUptime(stats.uptime) : '—'}</span>
            </div>
            <div className="flex justify-between text-text-dim">
              <span>App Uptime:</span>
              <span className="font-medium text-text tabular-nums">{stats ? formatUptime(stats.appUptime) : '—'}</span>
            </div>
            <div className="flex justify-between text-text-dim">
              <span>Node / Electron:</span>
              <span className="font-medium text-text">{stats ? `v${stats.nodeVersion} / v${stats.electronVersion}` : '—'}</span>
            </div>
            <div className="flex justify-between text-text-dim">
              <span>Active Terminals:</span>
              <span className="font-medium text-accent tabular-nums">{stats?.terminalsCount ?? 0}</span>
            </div>
          </div>
        </div>

        {}
        {stats?.flow && (
          <div className="rounded-panel border border-line-soft bg-bg-hover/20 p-2.5">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-text">
              <span className="flex items-center gap-1.5">
                <Zap size={13} className="text-[#e6c07b]" /> Command Bus
              </span>
              <span className="text-[10px] font-normal text-text-faint">
                queue {stats.flow.queueDepth} · lanes {stats.flow.busyLanes}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
              <div className="flex justify-between text-text-dim">
                <span>Submitted:</span>
                <span className="font-medium text-text tabular-nums">{stats.flow.counters['flow.submitted'] ?? 0}</span>
              </div>
              <div className="flex justify-between text-text-dim">
                <span>Applied:</span>
                <span className="font-medium text-text tabular-nums">{stats.flow.counters['flow.applied'] ?? 0}</span>
              </div>
              <div className="flex justify-between text-text-dim">
                <span>Rejected:</span>
                <span
                  className={`font-medium tabular-nums ${
                    (stats.flow.counters['flow.rejected'] ?? 0) > 0 ? 'text-danger' : 'text-text'
                  }`}
                  title={Object.entries(stats.flow.counters)
                    .filter(([k]) => k.startsWith('flow.rejected.'))
                    .map(([k, v]) => `${k.slice('flow.rejected.'.length)}: ${v}`)
                    .join(', ')}
                >
                  {stats.flow.counters['flow.rejected'] ?? 0}
                </span>
              </div>
              <div className="flex justify-between text-text-dim">
                <span>Transactions:</span>
                <span className="font-medium text-text tabular-nums">{stats.flow.counters['flow.transactions'] ?? 0}</span>
              </div>
              <div className="flex justify-between text-text-dim">
                <span>Conflicts / Rate-limited:</span>
                <span className="font-medium text-text tabular-nums">
                  {(stats.flow.counters['flow.rejected.conflict'] ?? 0) + (stats.flow.counters['flow.transactions_rejected.conflict'] ?? 0)} /{' '}
                  {stats.flow.counters['flow.rate_limited'] ?? 0}
                </span>
              </div>
              <div className="flex justify-between text-text-dim">
                <span>Apply latency:</span>
                <span className="font-medium text-text tabular-nums">
                  {stats.flow.timings['flow.apply_ms']
                    ? `${stats.flow.timings['flow.apply_ms'].avgMs.toFixed(1)}ms avg · ${stats.flow.timings['flow.apply_ms'].maxMs.toFixed(0)}ms max`
                    : '—'}
                </span>
              </div>
            </div>
          </div>
        )}

        {}
        <div className="rounded-panel border border-line-soft bg-bg-hover/20 p-2.5">
          <div className="mb-2 flex items-center justify-between text-xs font-semibold text-text">
            <span className="flex items-center gap-1.5">
              <Terminal size={13} className="text-[#c792ea]" /> Active Canvas Terminals ({stats?.activeTerminals?.length ?? 0})
            </span>
          </div>

          {!stats || !stats.activeTerminals || stats.activeTerminals.length === 0 ? (
            <div className="py-2 text-center text-xs text-text-faint">No running terminal sessions</div>
          ) : (
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {(stats.activeTerminals || []).map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between rounded-panel border border-line-soft/60 bg-bg-hover px-2 py-1 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-pill ${
                        t.running ? 'bg-emerald-400 animate-pulse' : 'bg-text-faint'
                      }`}
                    />
                    <span className="truncate font-medium text-text">{t.title}</span>
                    <span className="text-[10px] text-text-faint">
                      {t.pid ? `PID: ${t.pid}` : t.id}
                      {t.agentOwned ? ' (Agent)' : ''}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      className="rounded-panel p-1 text-text-dim hover:bg-danger/20 hover:text-danger"
                      onClick={() => void handleKillTerminal(t.id, t.title)}
                      title="Kill terminal process"
                      aria-label="Close terminal"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {}
        <div className="flex items-center gap-2 pt-1">
          <button
            className="flex flex-1 items-center justify-center gap-1.5 rounded-panel border border-line bg-bg-hover/30 px-2.5 py-1.5 text-xs text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
            onClick={() => void handleReleaseLocks()}
            title="Release all resource and task locks"
          >
            <Lock size={12} className="text-[#e6c07b]" /> Release All Locks
          </button>
        </div>
      </div>
    </div>
  )
})
