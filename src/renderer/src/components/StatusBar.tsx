import React, { useEffect, useRef, useState } from 'react'
import { Cpu } from 'lucide-react'

const POLL_MS = 2000

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function cpuColor(pct: number): string {
  if (pct > 80) return 'text-danger'
  if (pct > 50) return 'text-[#e6c07b]'
  return 'text-[#7aa2f7]'
}

/**
 * Always-on strip along the bottom edge, mounted once outside the per-view
 * branches so it stays visible across Canvas, Code and Overview alike — the
 * one place in the shell that is never a widget you can close.
 */
export default function StatusBar(): React.JSX.Element {
  const [cpuPercent, setCpuPercent] = useState<number | null>(null)
  const [now, setNow] = useState(() => new Date())
  const seqRef = useRef(0)

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const seq = ++seqRef.current
      try {
        const res = await window.api.system.cpu()
        if (!alive || seq !== seqRef.current) return
        if (!('error' in res)) setCpuPercent(res.cpuPercent)
      } catch {
        // Transient — the next tick retries; the bar just keeps its last value.
      }
    }
    void poll()
    const interval = setInterval(() => {
      if (!document.hidden) void poll()
    }, POLL_MS)
    return () => {
      alive = false
      seqRef.current += 1
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div
      role="status"
      aria-label="System status"
      className="status-bar pointer-events-none fixed inset-x-0 bottom-0 z-[40000] flex h-[22px] items-center justify-end gap-3 border-t border-line-soft bg-bg/90 px-3 text-[10px] text-text-faint backdrop-blur-sm select-none"
    >
      {cpuPercent !== null && (
        <span className="flex items-center gap-1 tabular-nums" title={`CPU load: ${cpuPercent}%`}>
          <Cpu size={11} className={cpuColor(cpuPercent)} />
          <span className={cpuColor(cpuPercent)}>{cpuPercent}%</span>
        </span>
      )}
      <span className="tabular-nums text-text-dim">{formatClock(now)}</span>
    </div>
  )
}
