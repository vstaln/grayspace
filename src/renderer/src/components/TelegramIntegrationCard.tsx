import { useEffect, useState } from 'react'
import type React from 'react'
import type { TelegramStatus } from '../../../preload/index.d'

const initialStatus: TelegramStatus = { state: 'disconnected' }

/** Self-contained card for the shared Settings → Integrations tab. */
export function TelegramIntegrationCard(): React.JSX.Element {
  const [token, setToken] = useState('')
  const [userId, setUserId] = useState('')
  const [targetTerminalId, setTargetTerminalId] = useState('')
  const [status, setStatus] = useState<TelegramStatus>(initialStatus)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    void Promise.all([window.api.telegram.getStatus(), window.api.settings.get()])
      .then(([nextStatus, settings]) => {
        if (!active) return
        setStatus(nextStatus)
        const s = settings as { telegramUserId?: string; telegramChatId?: string; targetTerminalId?: string }
        setUserId(s.telegramUserId || s.telegramChatId || '')
        setTargetTerminalId(s.targetTerminalId || '')
      })
      .catch(() => {
        if (active) setNotice('Failed to load Telegram settings')
      })
    const unsubscribe = window.api.telegram.onStatusChange(setStatus)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const save = async (disconnect = false): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const next = await window.api.telegram.save({
        telegramBotToken: disconnect ? null : token || undefined,
        telegramUserId: userId || null,
        telegramChatId: userId || null,
        targetTerminalId: targetTerminalId || null
      })
      setStatus(next)
      // The token persists in main either way, but on a failed connect it is
      // still what the user just typed — do not wipe it so they can retry.
      if (!disconnect && next.state !== 'error') setToken('')
      setNotice(disconnect ? 'Disconnected' : next.state === 'error' ? next.error || 'Connection error' : 'Saved')
    } catch {
      setNotice('Failed to save Telegram settings')
    } finally {
      setBusy(false)
    }
  }

  const testSend = async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const result = await window.api.telegram.testSend()
      setNotice('error' in result ? result.error || 'Failed to send test message' : 'Test message sent')
    } catch {
      setNotice('Failed to send test message')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-line bg-bg-panel/70 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text">Telegram</h3>
          <p className="mt-1 text-xs text-text-faint">Two-way bridge with selected terminal</p>
        </div>
        <span className={status.state === 'connected' ? 'text-xs text-ok' : status.state === 'error' ? 'text-xs text-danger' : 'text-xs text-text-faint'}>
          {status.state === 'connected' ? 'Connected' : status.state === 'error' ? 'Error' : 'Disconnected'}
        </span>
      </div>
      <div className="grid gap-2">
        <input className="rounded-lg border border-line bg-bg px-3 py-2 text-xs text-text" type="password" placeholder="Bot token" aria-label="Bot token" value={token} onChange={e => setToken(e.target.value)} />
        <input className="rounded-lg border border-line bg-bg px-3 py-2 text-xs text-text" placeholder="Allowed user ID" aria-label="Allowed Telegram user ID" value={userId} onChange={e => setUserId(e.target.value)} />
        <input className="rounded-lg border border-line bg-bg px-3 py-2 text-xs text-text" placeholder="Target terminal ID" aria-label="Target terminal ID" value={targetTerminalId} onChange={e => setTargetTerminalId(e.target.value)} />
      </div>
      {status.error ? <p className="mt-2 text-xs text-danger">{status.error}</p> : null}
      {status.lastMessage ? <p className="mt-2 truncate text-xs text-text-faint">Last: {status.lastMessage}</p> : null}
      {notice ? <p className="mt-2 text-xs text-text-faint">{notice}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50" disabled={busy || (!token.trim() && status.state !== 'connected')} onClick={() => void save()}>
          {status.state === 'connected' ? 'Save' : 'Connect'}
        </button>
        <button className="rounded-lg border border-line px-3 py-1.5 text-xs text-text disabled:opacity-50" disabled={busy || status.state === 'disconnected'} onClick={() => void save(true)}>
          Disconnect
        </button>
        <button className="rounded-lg border border-line px-3 py-1.5 text-xs text-text disabled:opacity-50" disabled={busy || status.state !== 'connected'} onClick={() => void testSend()}>
          Send Test
        </button>
      </div>
    </section>
  )
}

export default TelegramIntegrationCard
