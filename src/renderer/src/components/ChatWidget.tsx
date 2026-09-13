import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, LogIn, Settings2, Sparkles, Square, Trash2 } from 'lucide-react'
import type { ChatMessage, ChatProvider, ChatProviderStatus, ChatReasoningEffort } from '../../../preload/api'
import { useSettings } from '../hooks/useSettings'

const PROVIDERS: Array<{ id: ChatProvider; label: string }> = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'grok', label: 'Grok' }
]

const MODELS: Record<ChatProvider, string[]> = {
  chatgpt: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-luna'],
  claude: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  grok: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1']
}

const MODEL_MIGRATIONS: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-opus-4-1': 'claude-opus-5',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'grok-4': 'grok-4.6',
  'grok-4-fast': 'grok-4.6',
  'grok-3-mini': 'grok-4.3'
}

const EFFORTS: Array<{ id: ChatReasoningEffort; label: string; hint: string }> = [
  { id: 'low', label: 'Low', hint: 'Fast replies' },
  { id: 'medium', label: 'Medium', hint: 'Balanced' },
  { id: 'high', label: 'High', hint: 'Deeper reasoning' }
]

const STORAGE_PREFIX = 'orcspace-chat:'

function readMessages(widgetId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}messages:${widgetId}`)
    const value = raw ? JSON.parse(raw) : []
    if (!Array.isArray(value)) return []
    return value.slice(-100).filter((item): item is ChatMessage => Boolean(item) && typeof item === 'object' && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
  } catch {
    return []
  }
}

function readConfig(widgetId: string): { provider?: ChatProvider; model?: string; effort?: ChatReasoningEffort } {
  try {
    const value = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}config:${widgetId}`) || '{}') as Record<string, unknown>
    return {
      provider: value.provider === 'chatgpt' || value.provider === 'claude' || value.provider === 'grok' ? value.provider : undefined,
      model: typeof value.model === 'string' ? MODEL_MIGRATIONS[value.model] ?? value.model : undefined,
      effort: value.effort === 'low' || value.effort === 'high' || value.effort === 'medium' ? value.effort : undefined
    }
  } catch {
    return {}
  }
}

function newMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, content, createdAt: Date.now() }
}

export default function ChatWidget({ widgetId, workspaceDir }: { widgetId: string; workspaceDir?: string | null }): React.JSX.Element {
  const { settings, update } = useSettings()
  const savedConfig = useMemo(() => readConfig(widgetId), [widgetId])
  const initialProvider = savedConfig.provider ?? settings.aiProvider ?? 'chatgpt'
  const [provider, setProvider] = useState<ChatProvider>(initialProvider)
  const [model, setModel] = useState(savedConfig.model ?? settings.aiModel ?? MODELS[initialProvider][0])
  const [effort, setEffort] = useState<ChatReasoningEffort>(savedConfig.effort ?? settings.aiReasoningEffort ?? 'medium')
  const [messages, setMessages] = useState<ChatMessage[]>(() => readMessages(widgetId))
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ChatProviderStatus[]>([])
  const pendingRef = useRef<{ requestId?: string } | null>(null)
  const configTouchedRef = useRef(Boolean(savedConfig.provider || savedConfig.model || savedConfig.effort))
  const scrollRef = useRef<HTMLDivElement>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    const refreshProviders = (): void => { void window.api.chat.providers().then(setProviders).catch(() => {}) }
    refreshProviders()
    const off = window.api.chat.onEvent((event: import('../../../preload/api').ChatEvent) => {
      if (!aliveRef.current || event.widgetId !== widgetId) return
      if (pendingRef.current?.requestId && event.requestId !== pendingRef.current.requestId) return
      if (event.type === 'status') {
        setStatus(event.text || 'Thinking…')
      } else if (event.type === 'complete') {
        if (event.text) setMessages((current) => [...current, newMessage('assistant', event.text || '')])
        setBusy(false)
        setStatus('Ready')
        pendingRef.current = null
      } else {
        setBusy(false)
        setStatus('Needs attention')
        setError(event.text || 'The request failed.')
        pendingRef.current = null
      }
    })
    const offAuth = window.api.chat.onAuthEvent((event) => {
      if (event.type === 'complete' || event.type === 'error') refreshProviders()
    })
    return () => {
      aliveRef.current = false
      off()
      offAuth()
    }
  }, [widgetId])

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_PREFIX}messages:${widgetId}`, JSON.stringify(messages.slice(-100))) } catch {}
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, widgetId])

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_PREFIX}config:${widgetId}`, JSON.stringify({ provider, model, effort })) } catch {}
  }, [widgetId, provider, model, effort])

  useEffect(() => {
    if (configTouchedRef.current) return
    const nextProvider = settings.aiProvider ?? 'chatgpt'
    const nextModels = MODELS[nextProvider]
    setProvider(nextProvider)
    setModel(nextModels.includes(settings.aiModel ?? '') ? settings.aiModel ?? nextModels[0] : nextModels[0])
    setEffort(settings.aiReasoningEffort ?? 'medium')
  }, [settings.aiModel, settings.aiProvider, settings.aiReasoningEffort])

  const connected = providers.find((item) => item.id === provider)?.connected === true
  const availableModels = MODELS[provider]

  const changeProvider = (next: ChatProvider): void => {
    configTouchedRef.current = true
    const nextModel = MODELS[next][0]
    setProvider(next)
    setModel(nextModel)
    void update({ aiProvider: next, aiModel: nextModel })
    setError(null)
  }

  const changeModel = (next: string): void => {
    configTouchedRef.current = true
    setModel(next)
    void update({ aiModel: next })
  }

  const changeEffort = (next: ChatReasoningEffort): void => {
    configTouchedRef.current = true
    setEffort(next)
    void update({ aiReasoningEffort: next })
  }

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || busy) return
    setDraft('')
    setError(null)
    setBusy(true)
    setStatus('Starting…')
    const userMessage = newMessage('user', message)
    setMessages((current) => [...current, userMessage])
    let result: Awaited<ReturnType<typeof window.api.chat.send>>
    try {
      result = await window.api.chat.send({ widgetId, provider, model, reasoningEffort: effort, message, history: messages, workspaceDir })
    } catch (requestError) {
      if (!aliveRef.current) return
      setBusy(false)
      setStatus('Needs attention')
      setError(requestError instanceof Error ? requestError.message : 'Unable to start the request.')
      return
    }
    if (!aliveRef.current) return
    if (!result.ok) {
      setBusy(false)
      setStatus('Needs attention')
      setError(result.error || 'Unable to start the request.')
      return
    }
    pendingRef.current = { requestId: result.requestId }
  }

  const stop = (): void => {
    void window.api.chat.cancel(widgetId)
    pendingRef.current = null
    setBusy(false)
    setStatus('Stopped')
  }

  const clear = (): void => {
    if (busy) stop()
    setMessages([])
    setError(null)
    setStatus('Ready')
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="chat-widget">
      <div className="flex flex-wrap items-center gap-1.5 rounded-[9px] border border-line-soft bg-bg-raise p-1.5">
        <select aria-label="AI provider" value={provider} onChange={(event) => changeProvider(event.target.value as ChatProvider)} className="h-7 min-w-[100px] rounded-[7px] border border-line bg-transparent px-2 text-[10px] text-text outline-none focus:border-line">
          {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select aria-label="AI model" value={availableModels.includes(model) ? model : availableModels[0]} onChange={(event) => changeModel(event.target.value)} className="h-7 min-w-[140px] flex-1 rounded-[7px] border border-line bg-transparent px-2 text-[10px] text-text outline-none focus:border-line">
          {availableModels.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select aria-label="Reasoning effort" value={effort} onChange={(event) => changeEffort(event.target.value as ChatReasoningEffort)} className="h-7 min-w-[100px] rounded-[7px] border border-line bg-transparent px-2 text-[10px] text-text outline-none focus:border-line">
          {EFFORTS.map((item) => <option key={item.id} value={item.id}>{item.label} effort</option>)}
        </select>
        <span className="flex h-7 items-center gap-1 px-1 text-[10px] text-text-faint" title={connected ? 'Account connected' : 'Connect this provider in Settings'}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-text' : 'bg-line'}`} aria-hidden="true" />
          {connected ? 'Connected' : 'Not connected'}
        </span>
        <button type="button" aria-label="Open AI settings" title="AI settings" className="grid h-7 w-7 place-items-center rounded-[7px] text-text-faint hover:bg-bg-hover hover:text-text" onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-settings', { detail: { tab: 'ai' } }))}><Settings2 size={14} /></button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5" aria-live="polite">
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center px-5 text-center text-[11px] text-text-faint">
            <div><Sparkles className="mx-auto mb-2 opacity-60" size={22} /><p className="text-text-dim">Ask anything</p><p className="mt-1">Your conversation stays on this widget.</p></div>
          </div>
        ) : messages.map((item) => (
          <div key={item.id} className={`flex gap-2 rounded-[9px] border px-2.5 py-2 text-[11px] leading-relaxed ${item.role === 'user' ? 'ml-7 border-line bg-bg-hover' : 'mr-4 border-line-soft bg-bg-raise'}`}>
            {item.role === 'assistant' && <Bot size={14} className="mt-0.5 flex-none text-text-faint" />}
            <div className="min-w-0 whitespace-pre-wrap break-words text-text">{item.content}</div>
          </div>
        ))}
        {busy && <div className="mr-4 flex items-center gap-2 rounded-[9px] border border-line-soft bg-bg-raise px-2.5 py-2 text-[11px] text-text-faint"><Bot size={14} /><span>{status}</span></div>}
      </div>

      {error && <div role="alert" className="flex items-center gap-2 rounded-[8px] border border-line-soft bg-bg-raise px-2.5 py-1.5 text-[10px] text-text-faint"><LogIn size={13} className="flex-none" /><span className="min-w-0 flex-1">{error}</span><button type="button" className="text-text hover:underline" onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-settings', { detail: { tab: 'ai' } }))}>Settings</button></div>}
      <form className="flex items-end gap-1.5" onSubmit={(event) => void send(event)}>
        <textarea aria-label="Chat message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} rows={2} maxLength={12000} placeholder="Message the model…" className="min-h-[46px] min-w-0 flex-1 resize-none rounded-[8px] border border-line-soft bg-transparent px-2.5 py-2 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-line" />
        <button type={busy ? 'button' : 'submit'} aria-label={busy ? 'Stop response' : 'Send message'} title={busy ? 'Stop response' : 'Send message'} className="grid h-9 w-9 flex-none place-items-center rounded-[8px] bg-accent text-bg hover:opacity-90 disabled:cursor-default disabled:opacity-40" disabled={!busy && !draft.trim()} onClick={busy ? stop : undefined}>{busy ? <Square size={14} fill="currentColor" /> : <Sparkles size={15} />}</button>
      </form>
      <div className="flex items-center justify-between text-[10px] text-text-faint"><span>{status} · {EFFORTS.find((item) => item.id === effort)?.hint}</span><button type="button" aria-label="Clear chat" className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-bg-hover hover:text-text" onClick={clear}><Trash2 size={12} />Clear</button></div>
    </div>
  )
}
