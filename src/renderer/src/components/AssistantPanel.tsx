import React, { useEffect, useRef, useState } from 'react'
import { Bot, Check, Loader2, Play, X } from 'lucide-react'
import type { RunState } from '../../../preload/index.d'

interface Props {
  onClose(): void
}

/**
 * The built-in assistant's control surface.
 *
 * A run is autonomous but never silent: every step it takes is a command on
 * the same bus as the user's own edits, and anything destructive stops here
 * and waits for an answer. That gate is the reason this panel exists at all —
 * without somewhere to say "yes, delete it", the agent would either have to
 * ask permission it cannot ask for, or take it.
 */
export default function AssistantPanel({ onClose }: Props): React.JSX.Element {
  const [goal, setGoal] = useState('')
  const [run, setRun] = useState<RunState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Steps arrive as they happen, so the panel shows progress rather than
  // sitting blank until the whole run resolves.
  useEffect(() => window.api.assistant.onRun((next) => setRun(next)), [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [run?.log.length])

  const start = async (): Promise<void> => {
    const text = goal.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    const result = await window.api.assistant.start(text)
    setBusy(false)
    if (result && 'error' in result) {
      setError(result.error ?? 'ассистент не смог запуститься')
      return
    }
    setRun(result)
  }

  const answer = async (approved: boolean): Promise<void> => {
    if (!run) return
    setBusy(true)
    const next = await window.api.assistant.answer(run.runId, approved)
    setBusy(false)
    if (next) setRun(next)
  }

  const waiting = run?.status === 'waiting_human'

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Ассистент"
      className="fixed right-6 bottom-6 z-[700] flex h-[520px] w-[420px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[10px] border border-line bg-bg-panel shadow-[0_30px_90px_rgba(0,0,0,0.75)] glass:bg-bg-panel/80 glass:backdrop-blur-2xl"
    >
      <header className="flex flex-none items-center gap-2 border-b border-line-soft px-3.5 py-3">
        <Bot size={16} className="text-text-dim" />
        <h2 className="flex-1 text-[13px] font-semibold text-text">Ассистент</h2>
        {run && <StatusChip status={run.status} />}
        <button
          className="grid h-7 w-7 place-items-center rounded-[10px] text-text-faint hover:bg-bg-hover hover:text-text"
          title="Закрыть"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>

      <div ref={logRef} className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
        {!run && !error && (
          <p className="pt-10 text-center text-[12px] leading-relaxed text-text-faint">
            Опишите цель — ассистент составит план и выполнит его шаг за шагом.
            <br />
            Он работает как обычный участник: берёт блокировки, обходит занятые
            ресурсы и спрашивает перед всем, что удаляет.
          </p>
        )}
        {error && <p className="text-[12px] text-danger">{error}</p>}

        {run && (
          <>
            <p className="mb-2 text-[12px] text-text-dim">{run.goal}</p>
            {run.plan.length > 0 && (
              <ol className="mb-3 flex flex-col gap-1">
                {run.plan.map((step, i) => (
                  <li
                    key={`${step.command}-${i}`}
                    className={`flex items-start gap-2 rounded-[10px] border px-2.5 py-1.5 text-[11px] ${
                      i < run.cursor
                        ? 'border-line-soft text-text-faint'
                        : i === run.cursor
                          ? 'border-white/30 text-text'
                          : 'border-line-soft text-text-dim'
                    }`}
                  >
                    <span className="mt-px flex-none text-text-faint">{i + 1}.</span>
                    <span className="min-w-0 flex-1">{step.summary}</span>
                    <code className="flex-none text-text-faint">{step.command}</code>
                  </li>
                ))}
              </ol>
            )}
            <div className="flex flex-col gap-0.5">
              {run.log.map((line, i) => (
                <p key={i} className="text-[11px] leading-relaxed text-text-faint">
                  {line}
                </p>
              ))}
            </div>
            {run.error && <p className="mt-2 text-[11px] text-danger">{run.error}</p>}
          </>
        )}
      </div>

      {waiting ? (
        <div className="flex flex-none flex-col gap-2 border-t border-line-soft px-3.5 py-3">
          <p className="text-[12px] text-text">{run?.question}</p>
          <div className="flex gap-1.5">
            <button
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-black hover:bg-white"
              onClick={() => void answer(true)}
            >
              <Check size={13} /> Разрешить
            </button>
            <button
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-line px-3 py-1.5 text-[12px] text-text hover:bg-bg-hover"
              onClick={() => void answer(false)}
            >
              <X size={13} /> Отклонить
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-none gap-1.5 border-t border-line-soft px-3.5 py-3">
          <input
            className="min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-text-faint focus:border-text-faint"
            placeholder="Например: создай заметку с итогами сборки"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void start()
            }}
          />
          <button
            className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-accent text-black disabled:opacity-40 hover:bg-white"
            disabled={busy || !goal.trim()}
            title="Запустить"
            onClick={() => void start()}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          </button>
        </div>
      )}
    </section>
  )
}

function StatusChip({ status }: { status: RunState['status'] }): React.JSX.Element {
  const label =
    status === 'running'
      ? 'работает'
      : status === 'waiting_human'
        ? 'ждёт вас'
        : status === 'done'
          ? 'готово'
          : 'ошибка'
  const tone =
    status === 'failed'
      ? 'border-danger/40 text-danger'
      : status === 'waiting_human'
        ? 'border-[#f59e0b]/40 text-[#f59e0b]'
        : status === 'done'
          ? 'border-ok/40 text-ok'
          : 'border-line text-text-dim'
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone}`}>{label}</span>
}
