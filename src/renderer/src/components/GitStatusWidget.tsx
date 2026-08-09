import React, { useCallback, useEffect, useState } from 'react'
import { GitBranch, GitCommit, RefreshCw } from 'lucide-react'
import type { GitStatus } from '../../../preload/index.d'

/** Status is cheap to read but not free, so it refreshes on this beat. */
const POLL_MS = 8_000

/**
 * Repository status for the open project folder.
 *
 * Explicitly not a git client: no diff, no history, no staging area. The point
 * is to answer "where is this repo right now" at a glance while you work
 * beside it — and to let a commit go through the same lock an agent's
 * `git commit` in a terminal has to take, so the two cannot interleave.
 */
export default function GitStatusWidget(): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.api.git.status()
    if ('error' in result) {
      setError(result.error ?? 'не удалось прочитать репозиторий')
      return
    }
    setError(null)
    setStatus(result)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const commit = async (): Promise<void> => {
    const text = message.trim()
    if (!text || busy) return
    setBusy(true)
    const result = await window.api.git.commit(text)
    setBusy(false)
    if ('error' in result) {
      setError(result.error ?? 'коммит не прошёл')
      return
    }
    setMessage('')
    void refresh()
  }

  if (error) return <Shell><p className="text-[12px] text-danger">{error}</p></Shell>
  if (!status) return <Shell><p className="text-[12px] text-text-faint">Читаю репозиторий…</p></Shell>
  if (!status.repo)
    return (
      <Shell>
        <p className="text-[12px] text-text-faint">
          В папке проекта нет git-репозитория.
        </p>
      </Shell>
    )

  const dirty = status.modified + status.untracked + status.staged + status.conflicted

  return (
    <Shell>
      <div className="flex items-center gap-2">
        <GitBranch size={14} className="flex-none text-text-dim" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{status.branch ?? '—'}</span>
        <button
          className="grid h-6 w-6 flex-none place-items-center rounded-[10px] text-text-faint hover:bg-bg-hover hover:text-text"
          title="Обновить"
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Chip label="изменено" value={status.modified} />
        <Chip label="в индексе" value={status.staged} />
        <Chip label="новых" value={status.untracked} />
        {status.conflicted > 0 && <Chip label="конфликтов" value={status.conflicted} danger />}
        {status.ahead > 0 && <Chip label="↑ впереди" value={status.ahead} />}
        {status.behind > 0 && <Chip label="↓ позади" value={status.behind} />}
        {dirty === 0 && <span className="text-[11px] text-text-faint">рабочее дерево чистое</span>}
      </div>

      {status.lastCommit && (
        <div className="flex items-start gap-2 text-[11px] text-text-faint">
          <GitCommit size={12} className="mt-0.5 flex-none" />
          <span className="min-w-0">
            <code className="text-text-dim">{status.lastCommit.hash}</code> {status.lastCommit.subject}
          </span>
        </div>
      )}

      <div className="mt-auto flex gap-1.5">
        <input
          className="min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-2.5 py-1.5 text-[12px] text-text outline-none placeholder:text-text-faint focus:border-text-faint"
          placeholder="Сообщение коммита"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
          }}
        />
        <button
          className="flex-none rounded-[10px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-black disabled:opacity-40 hover:bg-white"
          // Committing nothing is not an error worth explaining after the fact.
          disabled={busy || !message.trim() || dirty === 0}
          onClick={() => void commit()}
        >
          {busy ? '…' : 'Коммит'}
        </button>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-full flex-col gap-2.5 p-3">{children}</div>
}

function Chip({ label, value, danger }: { label: string; value: number; danger?: boolean }): React.JSX.Element | null {
  if (!value) return null
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] ${
        danger ? 'border-danger/40 text-danger' : 'border-line-soft text-text-dim'
      }`}
    >
      {value} {label}
    </span>
  )
}
