import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, History, Play, RefreshCw, Trash2, X } from 'lucide-react'
import { CODE_AGENTS } from './CodeLauncher'
import {
  conversationKey,
  conversationsToResume,
  pruneSelection,
  readDismissed,
  relativeTime,
  visibleConversations,
  writeDismissed,
  type AgentConversation
} from '../lib/agentConversations'

interface Props {
  /** Folder the Code sessions run in; conversations are scoped to it. */
  dir: string
  /** How many more sessions Code can hold, so Resume cannot overfill it. */
  remainingSlots: number
  onResume(conversation: AgentConversation): void
  onResumeAll?(conversations: AgentConversation[]): void
}

const COLLAPSED_ROWS = 3
/**
 * How many "Resume all" opens when the user has not said which. It is one
 * click that starts real CLI processes, and a folder can hold dozens of past
 * conversations, so the blind action stays a handful. Ticking rows lifts it:
 * a selection is an explicit list, and only the free session slots cap that.
 */
const RESUME_ALL_MAX = 6
const COPY_FEEDBACK_MS = 1400
/** Relative labels drift; a slow tick keeps "24 minutes ago" honest. */
const CLOCK_TICK_MS = 60_000

function agentMeta(agentId: string): { label: string; Icon: React.ComponentType<{ size?: number }> } {
  const agent = CODE_AGENTS.find((candidate) => candidate.id === agentId)
  return { label: agent?.label ?? agentId, Icon: agent?.Icon ?? History }
}

/**
 * Only conversations Code can actually open are listed. An agent it does not
 * know would render a row whose Resume button quietly does nothing.
 */
function launchable(conversation: AgentConversation): boolean {
  return Boolean(conversation.command?.trim()) && CODE_AGENTS.some((agent) => agent.id === conversation.agentId)
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard permission can be missing in a packaged window; the command
    // stays selectable in the row either way.
    return false
  }
}

/**
 * "Resume your agents" — the conversations each CLI kept for this folder, with
 * the exact command that reopens one. Nothing here starts an agent by itself;
 * Code owns the session list and does the launching.
 */
export default function ResumeAgents({
  dir,
  remainingSlots,
  onResume,
  onResumeAll
}: Props): React.JSX.Element | null {
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  /** Rows the user ticked. Empty means "no choice made", not "none". */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [copyState, setCopyState] = useState<{ key: string; ok: boolean } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const requestRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
  }, [])

  const load = useCallback((): void => {
    if (!dir) {
      setConversations([])
      setLoading(false)
      return
    }
    // Folder switches and refreshes can overlap; only the newest answer wins.
    const run = ++requestRef.current
    setLoading(true)
    // An older preload has no such method; the panel simply stays away rather
    // than taking the whole Code view down with a TypeError.
    const query = window.api.code.conversations?.bind(window.api.code)
    if (!query) {
      setConversations([])
      setLoading(false)
      return
    }
    void query(dir)
      .then((list) => {
        if (run !== requestRef.current) return
        const safe = (Array.isArray(list) ? list : []).filter(launchable)
        setConversations(safe)
        // Drop dismissals whose transcript the agent has since deleted.
        setDismissed((current) => {
          const live = new Set(safe.map(conversationKey))
          const kept = Array.from(current).filter((key) => live.has(key))
          return kept.length === current.size ? current : new Set(kept)
        })
        setSelected((current) => {
          if (current.size === 0) return current
          const kept = pruneSelection(current, safe.map(conversationKey))
          return kept.size === current.size ? current : kept
        })

        setLoading(false)
      })
      .catch(() => {
        if (run !== requestRef.current) return
        setConversations([])
        setLoading(false)
      })
  }, [dir])

  useEffect(() => {
    setExpanded(false)
    setCopyState(null)
    setSelected(new Set())
    setDismissed(readDismissed(dir))
    load()
    return () => {
      // A pending answer for the old folder must not land on the new one.
      requestRef.current += 1
    }
  }, [dir, load])

  // Persisting from one place keeps every dismissal path pure, and keeps the
  // stored list pruned to conversations that still exist.
  useEffect(() => {
    // Nothing to prune against while a scan is in flight, or when a failed one
    // left the list empty — pruning then would erase what the user dismissed.
    if (loading || conversations.length === 0) return
    writeDismissed(dir, dismissed, conversations.map(conversationKey))
  }, [conversations, dir, dismissed, loading])

  const visible = useMemo(
    () => visibleConversations(conversations, dismissed),
    [conversations, dismissed]
  )

  const hiddenCount = conversations.length - visible.length
  const rows = expanded ? visible : visible.slice(0, COLLAPSED_ROWS)

  // What the bulk button would open right now, and therefore what it says.
  const toResume = useMemo(
    () => conversationsToResume(visible, selected, remainingSlots, RESUME_ALL_MAX),
    [remainingSlots, selected, visible]
  )
  const selectedCount = useMemo(
    () => visible.filter((conversation) => selected.has(conversationKey(conversation))).length,
    [selected, visible]
  )
  const resumableCount = toResume.length
  // A selection larger than the free slots opens as much of it as fits, and
  // says so rather than silently dropping the tail.
  const clipped = selectedCount > 0 ? selectedCount - resumableCount : visible.length - resumableCount
  const allSelected = selectedCount > 0 && selectedCount === visible.length

  const dismissOne = useCallback((conversation: AgentConversation): void => {
    const key = conversationKey(conversation)
    setDismissed((current) => {
      const next = new Set(current)
      next.add(key)
      return next
    })
    // A dismissed row must not keep counting toward the button.
    setSelected((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])

  const toggleSelected = useCallback((conversation: AgentConversation): void => {
    const key = conversationKey(conversation)
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback((): void => {
    if (allSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(visible.map(conversationKey)))
    // Ticking rows that are folded away would be a count with nothing behind
    // it, so show what is now selected.
    if (visible.length > COLLAPSED_ROWS) setExpanded(true)
  }, [allSelected, visible])

  const dismissAll = useCallback((): void => {
    setDismissed(new Set(conversations.map(conversationKey)))
    setSelected(new Set())
  }, [conversations])

  const restoreAll = useCallback((): void => {
    setDismissed(new Set())
  }, [])

  const copy = useCallback((conversation: AgentConversation): void => {
    const key = conversationKey(conversation)
    void copyText(conversation.command).then((ok) => {
      // A refused clipboard is reported in the row rather than swallowed, so
      // the command can be selected by hand instead of looking copied.
      setCopyState({ key, ok })
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null
        setCopyState((current) => (current?.key === key ? null : current))
      }, COPY_FEEDBACK_MS)
    })
  }, [])

  const resumePicked = useCallback((): void => {
    if (toResume.length === 0) return
    if (onResumeAll) {
      onResumeAll(toResume)
    } else {
      for (const conversation of toResume) onResume(conversation)
    }
    // The rows are open now; leaving them ticked would invite a second launch.
    setSelected(new Set())
  }, [onResume, onResumeAll, toResume])

  // Nothing recorded for this folder — the panel stays out of the way.
  if (conversations.length === 0) return null

  if (visible.length === 0) {
    return (
      <div className="mb-8 flex items-center gap-2 text-[12px] text-text-faint">
        <History size={13} className="flex-none" />
        <span>
          {hiddenCount} dismissed session{hiddenCount === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={restoreAll}
          className="min-h-[36px] rounded-panel px-2.5 text-[12px] text-text-dim transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
        >
          Show again
        </button>
      </div>
    )
  }

  return (
    <section
      data-testid="code-resume-agents"
      aria-label="Resume your agents"
      className="mb-8 overflow-hidden rounded-panel border border-line bg-bg-panel"
    >
      <header className="flex items-start gap-3 border-b border-line-soft px-4 py-3.5">
        <History size={15} className="mt-0.5 flex-none text-text-faint" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-text">Resume your agents</h2>
            <span className="rounded-pill border border-line-soft px-1.5 py-px text-[10px] text-text-faint">
              {visible.length}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-[1.45] text-text-faint">
            Conversations these CLIs kept in this folder. Resume one to pick it up where it stopped,
            or dismiss it to start fresh.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          aria-label="Refresh conversations"
          title="Refresh"
          className="grid h-9 w-9 min-h-[36px] flex-none place-items-center rounded-pill text-text-faint transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
        </button>
      </header>

      <ul className="flex flex-col gap-2 p-3">
        {rows.map((conversation) => {
          const key = conversationKey(conversation)
          const { label, Icon } = agentMeta(conversation.agentId)
          const copied = copyState?.key === key && copyState.ok
          const copyFailed = copyState?.key === key && !copyState.ok
          const name = conversation.title || `${label} session`
          const picked = selected.has(key)
          return (
            <li
              key={key}
              className={`rounded-panel border px-3 py-2.5 transition-colors duration-150 motion-reduce:transition-none hover:border-line ${
                picked ? 'border-line bg-bg-hover' : 'border-line-soft bg-bg-raise'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={picked}
                  onClick={() => toggleSelected(conversation)}
                  aria-label={`Select ${name}`}
                  title={picked ? 'Remove from the batch' : 'Add to the batch'}
                  className="grid h-9 w-5 min-h-[36px] flex-none place-items-center rounded-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                >
                  <span
                    className={`grid h-[15px] w-[15px] place-items-center rounded-panel border transition-colors duration-150 motion-reduce:transition-none ${
                      picked ? 'border-line bg-text text-bg' : 'border-line-soft text-transparent'
                    }`}
                  >
                    <Check size={10} strokeWidth={3} />
                  </span>
                </button>
                <span className="flex-none text-text-dim">
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-text" title={`${label} · ${name}`}>
                  {name}
                </span>
                <span className="flex-none text-[11px] text-text-faint">
                  {relativeTime(conversation.updatedAt, now)}
                </span>
                <button
                  type="button"
                  onClick={() => dismissOne(conversation)}
                  aria-label={`Dismiss ${name}`}
                  title="Dismiss"
                  className="grid h-9 w-9 min-h-[36px] flex-none place-items-center rounded-pill text-text-faint transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-panel border border-line-soft bg-bg px-2.5 py-2 font-mono text-[11px] text-text-dim" title={conversation.command}>
                  {conversation.command}
                </code>
                <button
                  type="button"
                  onClick={() => copy(conversation)}
                  aria-label={`Copy resume command for ${name}`}
                  title={copied ? 'Copied' : copyFailed ? 'Copy failed — select the command instead' : 'Copy command'}
                  className="grid h-9 w-9 min-h-[36px] flex-none place-items-center rounded-pill border border-line-soft text-text-faint transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                >
                  {copied ? <Check size={13} /> : copyFailed ? <X size={13} /> : <Copy size={13} />}
                </button>
                <button
                  type="button"
                  onClick={() => onResume(conversation)}
                  disabled={remainingSlots <= 0}
                  aria-label={`Resume ${name}`}
                  title={remainingSlots <= 0 ? 'No free session slots' : `Resume in a new ${label} session`}
                  className="flex h-9 min-h-[36px] flex-none items-center gap-1.5 rounded-panel border border-line bg-bg-hover px-3 text-[12px] font-medium text-text transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={11} />
                  Resume
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-3">
        <span className="mr-auto text-[11px] text-text-faint">
          {visible.length} session{visible.length === 1 ? '' : 's'} in this folder
          {hiddenCount > 0 ? ` · ${hiddenCount} dismissed` : ''}
          {selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
        </span>
        {visible.length > 1 && (
          <button
            type="button"
            onClick={toggleSelectAll}
            className="min-h-[36px] rounded-panel px-3 text-[12px] text-text-dim transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
          >
            {allSelected ? 'Clear selection' : `Select all (${visible.length})`}
          </button>
        )}
        {visible.length > COLLAPSED_ROWS && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            className="min-h-[36px] rounded-panel px-3 text-[12px] text-text-dim transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
          >
            {expanded ? 'Show less' : `Show all (${visible.length})`}
          </button>
        )}
        <button
          type="button"
          onClick={dismissAll}
          className="flex min-h-[36px] items-center gap-1.5 rounded-panel border border-line-soft px-3 text-[12px] text-text-dim transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
        >
          <X size={12} />
          Dismiss all
        </button>
        <button
          type="button"
          onClick={resumePicked}
          disabled={resumableCount === 0}
          title={
            resumableCount === 0
              ? 'No free session slots'
              : selectedCount > 0
                ? clipped > 0
                  ? `Only ${resumableCount} free session slots; the other ${clipped} stay in the list`
                  : `Opens the ${resumableCount} selected`
                : clipped > 0
                  ? `Opens the ${resumableCount} newest — tick rows to choose which, and how many`
                  : undefined
          }
          className="flex min-h-[36px] items-center gap-1.5 rounded-panel border border-line bg-bg-hover px-3 text-[12px] font-medium text-text transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Play size={12} />
          {selectedCount > 0 ? `Resume selected (${resumableCount})` : `Resume all (${resumableCount})`}
        </button>
      </footer>
    </section>
  )
}
