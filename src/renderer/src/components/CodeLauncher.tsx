import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Globe2, Rocket, Terminal, X } from 'lucide-react'
import { ClaudeIcon, CodexIcon, CursorIcon, GrokIcon, KimiIcon, OpenCodeIcon } from './agent-icons'
import AntigravityIcon from './AntigravityIcon'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useSettings } from '../hooks/useSettings'
import { agentLaunchCapacity, launchMemoryWarning, type AgentLaunchMemory } from '../lib/launchMemory'

export const MAX_CODE_SESSIONS = 32
export const CODE_LAUNCH_COUNTS = [1, 2, 4, 6, 8, 10, 12] as const

export interface CodeAgent {
  id: string
  label: string
  command: string
  Icon: React.ComponentType<{ size?: number }>
}

export const CODE_AGENTS: CodeAgent[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', command: 'codex', Icon: CodexIcon },
  { id: 'antigravity', label: 'Antigravity', command: 'agy', Icon: AntigravityIcon },
  { id: 'grok', label: 'Grok Build', command: 'grok', Icon: GrokIcon },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', Icon: OpenCodeIcon },
  { id: 'kimi', label: 'Kimi Code', command: 'kimi', Icon: KimiIcon },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', Icon: CursorIcon },
  { id: 'browser', label: 'Browser', command: 'browser', Icon: Globe2 },
  { id: 'custom', label: 'Other CLI', command: '', Icon: Terminal }
]

interface Props {
  onClose(): void
  onLaunch(agent: CodeAgent, count: number): void
  currentCount?: number
  anchorRect?: DOMRect | null
}

export default function CodeLauncher({
  onClose,
  onLaunch,
  currentCount = 0,
  anchorRect: _anchorRect
}: Props): React.JSX.Element {
  const [selectedAgentId, setSelectedAgentId] = useState<string>('claude')
  const [count, setCount] = useState(1)
  const [customCommand, setCustomCommand] = useState('')
  const { settings } = useSettings()
  // Re-read while the dialog is open: it gates the Launch button now, and a
  // dialog left open for a few minutes was deciding on a figure from whenever
  // it was opened.
  const [memory, setMemory] = useState<AgentLaunchMemory>({ freeBytes: 0, totalBytes: 0 })
  const dialogRef = useRef<HTMLElement>(null)
  useFocusTrap(dialogRef, true)

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.api.system.memory().then((stats) => {
        if (!alive || !('freeMem' in stats)) return
        setMemory({
          freeBytes: stats.freeMem,
          availableBytes: stats.availableMem,
          totalBytes: stats.totalMem,
          swapFreeBytes: stats.swapFree,
          swapTotalBytes: stats.swapTotal,
          platform: stats.platform
        })
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const remaining = Math.max(0, MAX_CODE_SESSIONS - currentCount)
  const customAgentChoices = (settings.customCodeAgents ?? []).map((entry) => ({
    selectionId: `preset:${entry.id}`,
    agent: { id: 'custom', label: entry.name, command: entry.command, Icon: Terminal }
  }))
  const fixedChoices = CODE_AGENTS.filter((agent) => agent.id !== 'custom').map((agent) => ({
    selectionId: agent.id,
    agent
  }))
  const customChoice = CODE_AGENTS.find((agent) => agent.id === 'custom')
  const choices = [
    ...fixedChoices,
    ...customAgentChoices,
    ...(customChoice ? [{ selectionId: 'custom', agent: customChoice }] : [])
  ]
  const selectedChoice = choices.find((choice) => choice.selectionId === selectedAgentId)
  const baseAgent = selectedChoice?.agent ?? CODE_AGENTS[0]
  const effectiveAgent: CodeAgent =
    selectedAgentId === 'custom'
      ? {
          ...baseAgent,
          command: customCommand.trim(),
          label: customCommand.trim() || 'Other CLI'
        }
      : baseAgent

  // The browser is one embedded widget, regardless of the count selected for
  // CLI agents before it.
  const isBrowser = selectedChoice?.agent.id === 'browser'
  const launchCount = isBrowser ? 1 : count
  // A browser widget is a webview inside this process, not an agent CLI, so
  // neither the per-agent estimate nor the memory budget applies to it.
  // Unmeasured memory falls back to the session cap alone: a stats read that
  // is slow or fails must not leave the Launch button permanently dead.
  const available = isBrowser ? remaining : agentLaunchCapacity(memory, remaining)
  const memoryWarning = isBrowser ? null : launchMemoryWarning(memory, launchCount)
  // Only the fixed session cap can be the limiter here without the warning
  // above already explaining it, so say so rather than just greying buttons.
  const cappedBySessions = !memoryWarning && launchCount > available
  const canLaunch =
    Boolean(selectedChoice) &&
    (selectedAgentId !== 'custom' || customCommand.trim().length > 0) &&
    launchCount > 0 &&
    launchCount <= available &&
    effectiveAgent.command.length > 0

  // Without this a selection made before the budget shrank just greys the
  // Launch button out, with the reason sitting on buttons the user is not
  // looking at. Step down to the largest offered count that still fits.
  useEffect(() => {
    if (isBrowser) {
      if (count !== 1) setCount(1)
      return
    }
    if (available <= 0 || count <= available) return
    const fits = CODE_LAUNCH_COUNTS.filter((n) => n <= available)
    setCount(fits.length > 0 ? fits[fits.length - 1] : available)
  }, [available, count, isBrowser])

  const handleLaunch = (): void => {
    if (!canLaunch) return
    onLaunch(effectiveAgent, launchCount)
    onClose()
  }

  return (
    <div
      className="code-launcher-shell fixed inset-0 z-[650] flex items-center justify-center bg-bg/80 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Launch Code Session"
        className="pop-in flex max-h-[calc(100vh-32px)] w-[560px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-panel border border-line bg-bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.5)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex flex-none items-center justify-between border-b border-line-soft bg-bg-raise px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-text">Launch Code Session</h2>
            <p className="mt-0.5 text-[11px] text-text-faint">
              Pick an agent or widget and how many to open
            </p>
          </div>
          <button
            type="button"
            className="grid h-8 w-8 min-h-[32px] min-w-[32px] place-items-center rounded-pill text-text-faint transition-colors duration-150 hover:bg-bg-hover hover:text-text"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className="flex flex-col gap-5 overflow-y-auto p-5">
          <div>
            <p className="mb-2 text-[11px] font-medium tracking-[0.08em] text-text-faint uppercase">
              Agent or widget
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {choices.map(({ selectionId, agent: a }) => {
                const isSelected = selectionId === selectedAgentId
                const IconComponent = a.Icon
                return (
                  <button
                    key={selectionId}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedAgentId(selectionId)
                      if (a.id === 'browser') setCount(1)
                    }}
                    className={`flex flex-col items-start gap-2.5 rounded-panel border p-3 text-left transition-colors duration-150 ${
                      isSelected
                        ? 'border-accent bg-bg-hover text-text'
                        : 'border-line-soft bg-bg-panel text-text-dim hover:border-line hover:bg-bg-hover hover:text-text'
                    }`}
                  >
                    <span className="flex w-full items-center justify-between">
                      <span className="grid h-8 w-8 flex-none place-items-center rounded-pill border border-line-soft bg-bg-raise text-text">
                        <IconComponent size={15} />
                      </span>
                      {isSelected && (
                        <span className="grid h-4 w-4 place-items-center rounded-pill bg-accent text-bg">
                          <Check size={10} strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <span className="truncate text-xs font-medium">{a.label}</span>
                  </button>
                )
              })}
            </div>
            {selectedAgentId === 'custom' && (
              <input
                autoFocus
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                placeholder="Command, e.g. aider or qwen"
                aria-label="Custom CLI command"
                className="mt-3 h-9 w-full rounded-panel border border-line-soft bg-bg-raise px-3 text-xs text-text outline-none transition-colors duration-150 focus:border-line"
              />
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="mb-2 text-[11px] font-medium tracking-[0.08em] text-text-faint uppercase">
                Instances
              </p>
              <div className="flex gap-1.5 rounded-panel border border-line-soft bg-bg-raise p-1">
                {CODE_LAUNCH_COUNTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={count === n}
                    disabled={n > available || (selectedAgentId === 'browser' && n !== 1)}
                    onClick={() => setCount(n)}
                    className={`min-h-[36px] min-w-[40px] rounded-panel px-3 py-1.5 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30 ${
                      count === n
                        ? 'border border-line bg-bg-hover text-text'
                        : 'text-text-dim hover:text-text'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-text-faint">
              Opens {launchCount}× <span className="text-text">{effectiveAgent.label}</span>
              {cappedBySessions && (
                <span className="text-danger"> (only {remaining} session{remaining === 1 ? '' : 's'} left)</span>
              )}
            </p>
            {memoryWarning && (
              <p
                role="status"
                data-testid="code-launch-memory-warning"
                className="flex items-start gap-1.5 text-[11px] leading-snug text-danger"
              >
                <AlertTriangle size={12} className="mt-[2px] flex-none" aria-hidden="true" />
                <span>{memoryWarning}</span>
              </p>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line-soft px-5 py-3.5">
          <button
            type="button"
            className="min-h-[36px] rounded-panel border border-line-soft px-4 py-1.5 text-xs text-text-dim transition-colors duration-150 hover:bg-bg-hover hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canLaunch}
            onClick={handleLaunch}
            className="flex min-h-[36px] items-center gap-1.5 rounded-panel bg-accent px-4 py-1.5 text-xs font-semibold text-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-35"
          >
            <Rocket size={13} />
            Launch {launchCount} {selectedAgentId === 'browser' ? 'widget' : `terminal${launchCount === 1 ? '' : 's'}`}
          </button>
        </footer>
      </section>
    </div>
  )
}
