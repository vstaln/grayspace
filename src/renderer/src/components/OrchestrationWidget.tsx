import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CircleDot, Clock, HelpCircle, Send, ShieldAlert, XCircle } from 'lucide-react'
import type { OrcDispatch, OrcMessage, OrcSnapshot, OrcTask, OrcTaskStatus } from '../../../preload/index.d'

const EMPTY: OrcSnapshot = { runs: [], tasks: [], dispatches: [], messages: [], gates: [] }

/** Column accents mirror the task lifecycle rather than inventing a new one. */
const STATUS_STYLE: Record<OrcTaskStatus, { label: string; className: string }> = {
  pending: { label: 'waiting', className: 'text-text-faint' },
  ready: { label: 'ready', className: 'text-accent' },
  dispatched: { label: 'running', className: 'text-amber-400' },
  completed: { label: 'done', className: 'text-emerald-400' },
  failed: { label: 'failed', className: 'text-red-400' },
  blocked: { label: 'blocked', className: 'text-orange-400' }
}

/**
 * The fleet, live.
 *
 * Agents drive every bit of this through the `orc` CLI — the window does not
 * dispatch work and does not report completions. What it does own is the half
 * of the contract that needs a human: answering a worker that asked a blocking
 * question, resolving a decision gate, and accounting for a worker that
 * finished. Those are the only three controls here, and they are deliberately
 * the only ones: a button that raced an agent's own command would be a way to
 * corrupt a run, not a convenience.
 */
export default function OrchestrationWidget(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<OrcSnapshot>(EMPTY)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const next = await window.api.orchestration.snapshot()
    if (alive.current) setSnapshot(next ?? EMPTY)
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    // The main process pushes a bare signal per change; re-reading here keeps
    // several of these widgets consistent without shipping a snapshot per
    // message during a burst of dispatch traffic.
    const off = window.api.orchestration.onChange(() => void refresh())
    return () => {
      alive.current = false
      off()
    }
  }, [refresh])

  const run = useMemo(() => snapshot.runs.find((r) => !r.closedAt) ?? snapshot.runs[0], [snapshot.runs])
  const tasks = useMemo(
    () => (run ? snapshot.tasks.filter((t) => t.runId === run.id) : []),
    [snapshot.tasks, run]
  )
  const dispatches = useMemo(
    () => (run ? snapshot.dispatches.filter((d) => d.runId === run.id) : []),
    [snapshot.dispatches, run]
  )
  const openGates = useMemo(
    () => snapshot.gates.filter((g) => !g.resolvedAt && (!run || g.runId === run.id)),
    [snapshot.gates, run]
  )

  /** Questions still waiting on an answer — a worker is blocked on each one. */
  const pendingAsks = useMemo(() => {
    const answered = new Set(snapshot.messages.filter((m) => m.type === 'reply').map((m) => m.replyTo))
    return snapshot.messages.filter((m) => m.type === 'ask' && !answered.has(m.id))
  }, [snapshot.messages])

  const unaccounted = useMemo(() => dispatches.filter((d) => d.state === 'settled'), [dispatches])
  const running = useMemo(() => dispatches.filter((d) => d.state === 'running'), [dispatches])

  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
      await refresh()
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[13px] text-text-dim">No run yet.</p>
        <p className="text-[11px] leading-relaxed text-text-faint">
          Ask an agent in any terminal to start one:
          <br />
          <code className="text-text-dim">orc run-create --objective &quot;...&quot;</code>
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden text-[12px]">
      <header className="flex flex-none items-baseline justify-between gap-3 border-b border-line-soft px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-text">{run.objective}</p>
          <p className="text-[10px] text-text-faint">
            {run.id} · coordinator {run.coordinator}
          </p>
        </div>
        <p className="flex-none text-[10px] text-text-faint">
          {running.length} running · {tasks.filter((t) => t.status === 'ready').length} ready
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {/* Things that need a person come first — everything else is agents' work. */}
        {pendingAsks.length > 0 && (
          <Section icon={<HelpCircle size={12} />} title="Waiting on you">
            {pendingAsks.map((ask) => (
              <AskCard
                key={ask.id}
                ask={ask}
                value={draft[ask.id] ?? ''}
                busy={busy === ask.id}
                onChange={(value) => setDraft((d) => ({ ...d, [ask.id]: value }))}
                onSend={() =>
                  act(ask.id, async () => {
                    await window.api.orchestration.reply(ask.id, draft[ask.id] ?? '')
                    setDraft((d) => ({ ...d, [ask.id]: '' }))
                  })
                }
              />
            ))}
          </Section>
        )}

        {openGates.length > 0 && (
          <Section icon={<ShieldAlert size={12} />} title="Decision gates">
            {openGates.map((gate) => (
              <div key={gate.id} className="mb-2 rounded-[8px] border border-line-soft bg-bg-hover/25 p-2">
                <p className="text-text">{gate.question}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(gate.options.length ? gate.options : ['ok']).map((option, optIdx) => (
                    <button
                      key={`${option}-${optIdx}`}
                      disabled={busy === gate.id}
                      className="rounded-[6px] border border-line bg-bg-raise px-2 py-1 text-[11px] text-text transition-colors hover:bg-bg-hover disabled:opacity-50"
                      onClick={() => act(gate.id, () => window.api.orchestration.resolveGate(gate.id, option))}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </Section>
        )}

        {unaccounted.length > 0 && (
          <Section icon={<CheckCircle2 size={12} />} title="Finished — keep or release">
            {unaccounted.map((dispatch) => (
              <div
                key={dispatch.id}
                className="mb-1.5 flex items-center justify-between gap-2 rounded-[8px] border border-line-soft bg-bg-hover/25 px-2 py-1.5"
              >
                <span className="min-w-0 truncate">
                  <OutcomeDot outcome={dispatch.outcome} />
                  <span className="ml-1.5 text-text-dim">{dispatch.taskId}</span>
                  <span className="ml-1.5 text-text-faint">{dispatch.agent}</span>
                </span>
                <span className="flex flex-none gap-1">
                  <button
                    disabled={busy === dispatch.id}
                    className="rounded-[6px] border border-line px-2 py-0.5 text-[11px] text-text-dim hover:bg-bg-hover disabled:opacity-50"
                    onClick={() => act(dispatch.id, () => window.api.orchestration.account(dispatch.id, 'retained'))}
                  >
                    Keep
                  </button>
                  <button
                    disabled={busy === dispatch.id}
                    className="rounded-[6px] border border-line px-2 py-0.5 text-[11px] text-text-dim hover:bg-bg-hover disabled:opacity-50"
                    onClick={() =>
                      act(dispatch.id, () => window.api.orchestration.account(dispatch.id, 'released', true))
                    }
                  >
                    Release
                  </button>
                </span>
              </div>
            ))}
          </Section>
        )}

        <Section icon={<CircleDot size={12} />} title={`Tasks (${tasks.length})`}>
          {tasks.length === 0 ? (
            <p className="text-[11px] text-text-faint">
              No tasks yet — <code>orc task-create --spec &quot;...&quot;</code>
            </p>
          ) : (
            tasks.map((task) => <TaskRow key={task.id} task={task} dispatches={dispatches} />)
          )}
        </Section>

        <Section icon={<Clock size={12} />} title="Recent mail">
          {snapshot.messages
            .slice(-12)
            .reverse()
            .map((message) => (
              <p key={message.id} className="mb-1 truncate text-[11px] text-text-faint">
                <span className="text-text-dim">{message.type}</span> · {message.from} → {message.to} ·{' '}
                {message.subject}
              </p>
            ))}
        </Section>
      </div>
    </div>
  )
}

function Section({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-3">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-faint">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function TaskRow({ task, dispatches }: { task: OrcTask; dispatches: OrcDispatch[] }): React.JSX.Element {
  const style = STATUS_STYLE[task.status]
  const live = dispatches.find((d) => d.taskId === task.id && d.state === 'running')
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className={`flex-none text-[10px] ${style.className}`}>{style.label}</span>
      <span className="min-w-0 flex-1 truncate text-text-dim">{task.title}</span>
      {task.deps.length > 0 && <span className="flex-none text-[10px] text-text-faint">↳{task.deps.length}</span>}
      {live && <span className="flex-none text-[10px] text-text-faint">{live.agent}</span>}
    </div>
  )
}

function AskCard({
  ask,
  value,
  busy,
  onChange,
  onSend
}: {
  ask: OrcMessage
  value: string
  busy: boolean
  onChange(value: string): void
  onSend(): void
}): React.JSX.Element {
  return (
    <div className="mb-2 rounded-[8px] border border-line-soft bg-bg-hover/25 p-2">
      <p className="text-[10px] text-text-faint">
        {ask.from}
        {ask.taskId ? ` · ${ask.taskId}` : ''}
      </p>
      <p className="mt-0.5 text-text">{ask.body || ask.subject}</p>
      {ask.options && ask.options.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {ask.options.map((option, optIdx) => (
            <button
              key={`${option}-${optIdx}`}
              disabled={busy}
              className="rounded-[6px] border border-line bg-bg-raise px-2 py-0.5 text-[11px] text-text hover:bg-bg-hover disabled:opacity-50"
              onClick={() => {
                onChange(option)
                // Picking an option is answering it — one click, not two.
                queueMicrotask(onSend)
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex gap-1">
        <input
          value={value}
          disabled={busy}
          placeholder="Answer…"
          className="min-w-0 flex-1 rounded-[6px] border border-line bg-bg-raise px-2 py-1 text-[11px] text-text outline-none focus:border-accent"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) onSend()
          }}
        />
        <button
          disabled={busy || !value.trim()}
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[6px] border border-line bg-bg-raise text-text-dim hover:bg-bg-hover disabled:opacity-40"
          onClick={onSend}
          title="Send reply"
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  )
}

function OutcomeDot({ outcome }: { outcome?: 'succeeded' | 'failed' }): React.JSX.Element {
  return outcome === 'failed' ? (
    <XCircle size={11} className="inline text-red-400" />
  ) : (
    <CheckCircle2 size={11} className="inline text-emerald-400" />
  )
}
