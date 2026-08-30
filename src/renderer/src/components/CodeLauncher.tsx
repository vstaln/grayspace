import React, { useRef, useState } from 'react'
import { Check, Rocket, Terminal, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import ClaudeIcon from './ClaudeIcon'
import CodexIcon from './CodexIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import OpenCodeIcon from './OpenCodeIcon'

export interface CodeAgent {
  id: string
  label: string
  command: string
  Icon: React.ComponentType<{ size?: number }>
}

/** Same command set as the per-terminal agent picker in WidgetFrame, plus the
 *  one this panel adds (OpenCode) — kept here rather than imported so neither
 *  file has to widen its own list for the other's sake. */
export const CODE_AGENTS: CodeAgent[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', command: 'codex', Icon: CodexIcon },
  { id: 'antigravity', label: 'Antigravity', command: 'agy', Icon: AntigravityIcon },
  { id: 'grok', label: 'Grok', command: 'grok', Icon: GrokIcon },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', Icon: OpenCodeIcon },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', Icon: Terminal },
  { id: 'custom', label: 'Other CLI', command: '', Icon: Terminal }
]

const COUNTS = [1, 2, 4, 8, 12] as const

interface Props {
  onClose(): void
  /** Resolves once the terminals have been placed; the panel closes itself. */
  onLaunch(agent: CodeAgent, count: number): void
}

export default function CodeLauncher({ onClose, onLaunch }: Props): React.JSX.Element {
  const [agentId, setAgentId] = useState(CODE_AGENTS[0].id)
  const [count, setCount] = useState<(typeof COUNTS)[number]>(4)
  const [customCommand, setCustomCommand] = useState('')
  const panelRef = useRef<HTMLElement>(null)
  useFocusTrap(panelRef, true)

  const selected = CODE_AGENTS.find((a) => a.id === agentId) ?? CODE_AGENTS[0]
  const agent = selected.id === 'custom' ? { ...selected, command: customCommand.trim(), label: customCommand.trim() || 'Other CLI' } : selected

  const launch = (): void => {
    onLaunch(agent, count)
    onClose()
  }

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Launch Code Session"
      className="code-launcher-shell fixed inset-0 z-[650] flex items-center justify-center bg-black/35"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="flex w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[10px] border border-line shadow-[0_30px_90px_rgba(0,0,0,0.75)] glass:border-line-soft glass:bg-bg-panel/72 glass:backdrop-blur-2xl glass:backdrop-saturate-150"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="flex flex-none items-center justify-between gap-4 border-b border-line-soft bg-bg-raise px-4 py-3.5 glass:bg-transparent">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-text">Launch Code Session</h2>
            <p className="mt-0.5 text-[11px] text-text-faint">Pick an agent and how many terminals to open</p>
          </div>
          <button
            className="grid h-8 w-8 flex-none place-items-center rounded-[10px] border border-line bg-bg-hover/40 text-text transition-colors duration-150 hover:bg-bg-hover"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-4">
          <div>
            <p className="mb-2 text-[11px] font-semibold text-text-faint">Agent</p>
            <div className="grid grid-cols-3 gap-2">
              {CODE_AGENTS.map((a) => {
                const selected = a.id === agentId
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setAgentId(a.id)}
                    className={`flex flex-col items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors duration-150 ${
                      selected
                        ? 'border-line bg-bg-hover'
                        : 'border-line-soft bg-bg-hover/20 hover:bg-bg-hover/40'
                    }`}
                  >
                    <span className="flex w-full items-center justify-between">
                      <span className="grid h-8 w-8 place-items-center rounded-[8px] border border-line-soft bg-bg-raise text-text-dim">
                        <a.Icon size={15} />
                      </span>
                      <span
                        className={`grid h-4 w-4 place-items-center rounded-full border ${
                          selected ? 'border-accent bg-accent text-bg' : 'border-line text-transparent'
                        }`}
                      >
                        <Check size={10} strokeWidth={3} />
                      </span>
                    </span>
                    <span className="text-[13px] font-medium text-text">{a.label}</span>
                  </button>
                )
              })}
            </div>
            {agentId === 'custom' && (
              <input
                autoFocus
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                placeholder="Command, e.g. aider or qwen"
                aria-label="Custom CLI command"
                className="mt-2 h-9 w-full rounded-[8px] border border-line-soft bg-bg-raise px-2.5 text-[12px] text-text outline-none focus:border-accent"
              />
            )}
          </div>

          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-[11px] font-semibold text-text-faint">Instances</p>
              <div className="flex gap-1 rounded-[10px] border border-line-soft bg-bg-hover/20 p-1">
                {COUNTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={count === n}
                    onClick={() => setCount(n)}
                    className={`min-w-[44px] rounded-[8px] px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 ${
                      count === n ? 'bg-bg-hover text-text' : 'text-text-faint hover:text-text'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <p className="pb-1.5 text-[11px] text-text-faint">
              Opens {count}× <span className="text-text-dim">{agent.label}</span>
            </p>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-3">
          <button
            className="rounded-[10px] border border-line bg-bg-hover/40 px-3.5 py-1.5 text-xs text-text transition-colors duration-150 hover:bg-bg-hover"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="flex items-center gap-1.5 rounded-[10px] bg-accent px-3.5 py-1.5 text-xs font-semibold text-bg transition-opacity duration-150 hover:opacity-90"
            onClick={launch}
            disabled={!agent.command}
          >
            <Rocket size={13} /> Launch {count} terminals
          </button>
        </footer>
      </div>
    </section>
  )
}
