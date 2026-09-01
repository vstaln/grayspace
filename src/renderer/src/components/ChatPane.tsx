import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Copy,
  Check,
  Send,
  Plus,
  Search,
  Sparkles,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  Paperclip,
  MoreHorizontal,
  Terminal as TerminalIcon,
  FileCode,
  Wrench
} from 'lucide-react'
import CodexIcon from './CodexIcon'
import ClaudeIcon from './ClaudeIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import OpenCodeIcon from './OpenCodeIcon'
import { renderMarkdownSafe } from '../lib/markdown'

type ChatModel = 'codex' | 'claude' | 'grok' | 'antigravity' | 'opencode'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  model?: ChatModel
  at: number
}

interface ChatThread {
  id: string
  title: string
  model: ChatModel
  messages: ChatMessage[]
  at: number
}

const MODELS: { id: ChatModel; label: string; Icon: React.ComponentType<{ size?: number }>; desc: string }[] = [
  { id: 'codex', label: 'Codex', Icon: CodexIcon, desc: 'Code + review' },
  { id: 'claude', label: 'Claude', Icon: ClaudeIcon, desc: 'Reasoning' },
  { id: 'antigravity', label: 'Antigravity', Icon: AntigravityIcon, desc: 'Research' },
  { id: 'grok', label: 'Grok', Icon: GrokIcon, desc: 'Fast' },
  { id: 'opencode', label: 'OpenCode', Icon: OpenCodeIcon, desc: 'Local' },
]

const MODEL_COMMAND: Record<ChatModel, string> = {
  codex: 'codex',
  claude: 'claude',
  grok: 'grok',
  antigravity: 'agy',
  opencode: 'opencode'
}

const LS_KEY = 'orcspace-chat-threads-v1'

function loadThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ChatThread[]
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 50)
  } catch {
    return []
  }
}

function saveThreads(threads: ChatThread[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(threads.slice(0, 50)))
  } catch {}
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function stripAnsi(s: string): string {
  // keep simple: remove ESC sequences for display, keep text
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '')
}

// split ``` fences for nice code blocks
function MessageContent({ text }: { text: string }): React.JSX.Element {
  const parts = useMemo(() => {
    const segs: { type: 'text' | 'code'; value: string; lang?: string }[] = []
    const re = /```(\w*)\n?([\s\S]*?)```/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) segs.push({ type: 'text', value: text.slice(last, m.index) })
      segs.push({ type: 'code', value: m[2], lang: m[1] || 'txt' })
      last = m.index + m[0].length
    }
    if (last < text.length) segs.push({ type: 'text', value: text.slice(last) })
    if (segs.length === 0) segs.push({ type: 'text', value: text })
    return segs
  }, [text])

  return (
    <div className="space-y-2.5 text-[13px] leading-[1.6] text-text">
      {parts.map((p, i) =>
        p.type === 'code' ? (
          <CodeBlock key={i} code={p.value} lang={p.lang} />
        ) : (
          <div
            key={i}
            className="prose max-w-none break-words text-[13px] leading-[1.6] text-text prose-strong:text-text prose-code:rounded prose-code:bg-bg-raise prose-code:px-[3px] prose-code:py-[1px] prose-code:text-[12px] prose-code:text-text prose-a:text-accent prose-a:underline-offset-2"
            dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(p.value) }}
          />
        )
      )}
    </div>
  )
}

function CodeBlock({ code, lang }: { code: string; lang?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }, [code])
  return (
    <div className="overflow-hidden rounded-[8px] border border-line-soft bg-[#0f0f11]">
      <div className="flex h-7 items-center justify-between border-b border-line-soft bg-bg-raise/60 px-2.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-faint">
          <FileCode size={12} /> {lang || 'code'}
        </span>
        <button
          onClick={copy}
          className="grid h-6 w-6 place-items-center rounded-md text-text-faint hover:bg-bg-hover hover:text-text"
          title="Copy"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-[1.55] text-[#d6d6d8]">{code.trimEnd()}</pre>
    </div>
  )
}

interface Props { active: boolean }

export default function ChatPane({ active }: Props): React.JSX.Element {
  const [threads, setThreads] = useState<ChatThread[]>(() => loadThreads())
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => threads[0]?.id ?? null)
  const [model, setModel] = useState<ChatModel>('codex')
  const [query, setQuery] = useState('')
  const [input, setInput] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // одному треду — один скрытый pty `chat-<threadId>`; данные pty стримим в последний assistant
  const chatTerminalsRef = useRef<Set<string>>(new Set())
  const pendingAssistantRef = useRef<string | null>(null)

  const activeThread = useMemo(() => threads.find(t => t.id === activeThreadId) ?? null, [threads, activeThreadId])

  useEffect(() => { saveThreads(threads) }, [threads])

  useEffect(() => {
    if (!active) return
    setTimeout(() => inputRef.current?.focus(), 80)
  }, [active])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [activeThread?.messages.length])

  const createThread = useCallback((initialModel: ChatModel = model) => {
    const t: ChatThread = { id: makeId(), title: 'New chat', model: initialModel, messages: [], at: Date.now() }
    setThreads(prev => [t, ...prev])
    setActiveThreadId(t.id)
    setModel(initialModel)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [model])

  const deleteThread = useCallback((id: string) => {
    // also dispose its hidden pty if exists
    const termId = `chat-${id}`
    if (chatTerminalsRef.current.has(termId)) {
      chatTerminalsRef.current.delete(termId)
      void window.api.terminal.dispose(termId).catch(()=>{})
    }
    setThreads(prev => {
      const next = prev.filter(t => t.id !== id)
      if (activeThreadId === id) setActiveThreadId(next[0]?.id ?? null)
      return next
    })
  }, [activeThreadId])

  // subscribe to pty output of active chat terminal and append to pending assistant message
  useEffect(() => {
    if (!activeThreadId) return
    const termId = `chat-${activeThreadId}`
    if (!chatTerminalsRef.current.has(termId)) return
    const unsub = window.api.terminal.onData(termId, (data: string) => {
      const assistantId = pendingAssistantRef.current
      if (!assistantId) return
      const chunk = stripAnsi(data)
      // ignore empty or just echo of user input? keep raw for transparency — как в Codex покажем всё
      if (!chunk.trim()) return
      setThreads(prev => prev.map(t => {
        if (t.id !== activeThreadId) return t
        return {
          ...t,
          messages: t.messages.map(m => m.id === assistantId ? { ...m, content: (m.content + chunk).slice(-8000) } : m),
          at: Date.now()
        }
      }))
    })
    return () => { try { unsub() } catch {} }
  }, [activeThreadId, threads.length])

  const ensureChatTerminal = useCallback(async (threadId: string, threadModel: ChatModel): Promise<string> => {
    const termId = `chat-${threadId}`
    if (chatTerminalsRef.current.has(termId)) return termId
    // create hidden pty for this thread
    try {
      await window.api.terminal.create(termId, 120, 30)
    } catch {}
    chatTerminalsRef.current.add(termId)
    // launch the model's CLI once
    const cmd = MODEL_COMMAND[threadModel]
    // small delay to let shell be ready
    await new Promise(r => setTimeout(r, 280))
    try { await window.api.terminal.write(termId, `${cmd}\r`) } catch {}
    return termId
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    let threadId = activeThreadId
    let threadModel = model
    if (!threadId) {
      const t: ChatThread = { id: makeId(), title: text.slice(0, 32) || 'New chat', model, messages: [], at: Date.now() }
      threadId = t.id
      threadModel = t.model
      setThreads(prev => [t, ...prev])
      setActiveThreadId(t.id)
    }
    const userMsg: ChatMessage = { id: makeId(), role: 'user', content: text, at: Date.now() }
    const assistantId = makeId()
    const assistantPlaceholder: ChatMessage = { id: assistantId, role: 'assistant', content: '', model: threadModel, at: Date.now() }
    pendingAssistantRef.current = assistantId
    setInput('')
    setThreads(prev => prev.map(t => t.id === threadId ? {
      ...t,
      title: t.messages.length === 0 ? text.slice(0, 40) : t.title,
      messages: [...t.messages, userMsg, assistantPlaceholder],
      at: Date.now()
    } : t))

    // ensure pty and send via CLI — отображение остаётся в чате (вид Codex, логика CLI)
    try {
      const termId = await ensureChatTerminal(threadId, threadModel)
      // give CLI a moment to be ready if just launched, then send user prompt
      await new Promise(r => setTimeout(r, 180))
      await window.api.terminal.write(termId, `${text}\r`)
      // fallback: if no data comes in 1.2s, show hint как в Codex (вид, но без мока)
      setTimeout(() => {
        setThreads(prev => {
          const th = prev.find(t=>t.id===threadId)
          const msg = th?.messages.find(m=>m.id===assistantId)
          if (msg && !msg.content.trim()) {
            return prev.map(t=> t.id===threadId ? { ...t, messages: t.messages.map(m=> m.id===assistantId ? { ...m, content: `_Отправлено в CLI \`${MODEL_COMMAND[threadModel]}\` — ответ появится здесь. Открой Code tab или терминал \`${termId}\` чтобы увидеть полный вывод._` } : m)} : t)
          }
          return prev
        })
      }, 1400)
    } catch (e) {
      setThreads(prev => prev.map(t=> t.id===threadId ? { ...t, messages: t.messages.map(m=> m.id===assistantId ? { ...m, content: `Ошибка отправки в CLI: ${String(e)}` } : m)} : t))
    }
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [input, activeThreadId, model, ensureChatTerminal])

  const filtered = useMemo(() => {
    if (!query.trim()) return threads
    const q = query.toLowerCase()
    return threads.filter(t => t.title.toLowerCase().includes(q) || t.messages.some(m => m.content.toLowerCase().includes(q)))
  }, [threads, query])

  const ModelIcon = MODELS.find(m => m.id === model)?.Icon ?? CodexIcon

  return (
    <div
      className={`absolute inset-y-0 right-0 left-rail z-[40000] flex flex-col bg-[#0a0a0b] pt-10 ${active ? '' : 'pointer-events-none invisible'}`}
      aria-hidden={!active}
    >
      <div className="flex h-9 flex-none items-center justify-between gap-2 border-b border-line-soft bg-bg-panel px-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="grid h-7 w-7 place-items-center rounded-[6px] text-text-faint hover:bg-bg-hover hover:text-text"
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-text">
            <Sparkles size={14} className="text-accent" /> Chat
            <span className="hidden sm:inline font-normal text-text-faint">— Codex вид в OrcSpace</span>
          </span>
          <span className="hidden md:flex items-center gap-1 rounded-full border border-line-soft bg-bg-raise px-2 py-0.5 text-[11px] text-text-faint">
            <ModelIcon size={12} /> {MODELS.find(m=>m.id===model)?.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="hidden sm:flex items-center gap-1 rounded-full border border-line-soft bg-bg-raise p-[2px]">
            {MODELS.map(m => {
              const isActive = m.id === model
              return (
                <button
                  key={m.id}
                  onClick={() => setModel(m.id)}
                  title={`${m.label} — ${m.desc}`}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${isActive ? 'bg-[#2a2a2e] text-[#ececec]' : 'text-text-faint hover:text-text'}`}
                >
                  <m.Icon size={12} /> {m.label}
                </button>
              )
            })}
          </div>
          <button
            onClick={() => createThread(model)}
            className="flex items-center gap-1.5 rounded-[8px] border border-line-soft bg-bg-hover/40 px-2.5 py-1 text-[12px] font-medium text-text hover:bg-bg-hover"
          >
            <Plus size={13} /> New
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="flex w-[280px] flex-none flex-col border-r border-line-soft bg-[#121214]">
            <div className="p-2.5">
              <label className="relative flex items-center">
                <Search size={13} className="pointer-events-none absolute left-2.5 text-text-faint" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search chats"
                  className="h-8 w-full rounded-[8px] border border-line-soft bg-bg-raise pl-8 pr-2.5 text-[12px] text-text placeholder:text-text-faint outline-none focus:border-line"
                />
              </label>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {filtered.length === 0 ? (
                <div className="px-2 py-8 text-center text-[12px] text-text-faint">
                  No chats yet.<br />Start with Codex or Claude.
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Recents</p>
                    <div className="space-y-1">
                      {filtered.map(t => {
                        const isActive = t.id === activeThreadId
                        const preview = t.messages[t.messages.length - 1]?.content.slice(0, 64) || 'No messages yet'
                        const MIcon = MODELS.find(m=>m.id===t.model)?.Icon ?? TerminalIcon
                        return (
                          <button
                            key={t.id}
                            onClick={() => setActiveThreadId(t.id)}
                            className={`group flex w-full flex-col gap-1 rounded-[8px] border px-2.5 py-2 text-left transition-colors ${isActive ? 'border-line bg-bg-hover text-text' : 'border-transparent bg-transparent text-text hover:bg-bg-hover/60 hover:text-text'}`}
                          >
                            <span className="flex w-full items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                                <span className="grid h-5 w-5 place-items-center rounded-[6px] border border-line-soft bg-bg-raise text-text-faint">
                                  <MIcon size={11} />
                                </span>
                                <span className="truncate">{t.title}</span>
                              </span>
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={e => { e.stopPropagation(); deleteThread(t.id) }}
                                onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); deleteThread(t.id) } }}
                                className="grid h-5 w-5 place-items-center rounded text-text-faint opacity-0 hover:bg-bg-raise hover:text-text group-hover:opacity-100"
                                title="Delete chat"
                              >
                                <Trash2 size={11} />
                              </span>
                            </span>
                            <span className="line-clamp-1 text-[11px] text-text-faint">{preview}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="border-t border-line-soft p-2 text-[11px] text-text-faint">
              <span className="flex items-center gap-1"><TerminalIcon size={11} /> Отправка через CLI</span>
              <span className="text-[11px] leading-tight">сообщение уходит в <code className="font-mono text-text-dim">{MODEL_COMMAND[model]}</code> в скрытый pty, ответ стримится сюда</span>
            </div>
          </aside>
        )}

        <main className="flex min-h-0 flex-1 flex-col bg-[#0a0a0b]">
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {!activeThread || activeThread.messages.length === 0 ? (
              <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-10">
                <div className="rounded-[12px] border border-line-soft bg-bg-panel p-5">
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold text-text">
                    <CodexIcon size={16} /> Codex вид — только вид, без мока
                  </h2>
                  <p className="mt-1.5 text-[13px] leading-[1.6] text-text-dim">
                    Тёмный graphite, hairline границы. Вводишь — уходит в твой CLI <code className="rounded bg-bg-raise px-1 text-text">{MODEL_COMMAND[model]}</code> (скрытый pty <code className="font-mono text-[11px]">chat-…</code>), ответ стримится сюда в чат.
                  </p>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {[
                      'Объясни архитектуру CodeView',
                      'Сделай review ChatPane',
                      'Напиши тест для migration browser→chat',
                      'Покажи diff — вид Codex',
                    ].map(prompt => (
                      <button
                        key={prompt}
                        onClick={() => { setInput(prompt); setTimeout(()=> inputRef.current?.focus(), 0) }}
                        className="rounded-[10px] border border-line-soft bg-bg-raise px-3 py-2.5 text-left text-[12px] leading-[1.45] text-text-dim hover:bg-bg-hover hover:text-text"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { k: 'Terminal', v: '#121214 solid', sub: 'xterm + WidgetFrame' },
                    { k: 'Hairline', v: 'rgba(255,255,255,0.06)', sub: 'border-line-soft' },
                    { k: 'Panel', v: '#141417', sub: 'bg-bg-panel' },
                  ].map(card => (
                    <div key={card.k} className="rounded-[10px] border border-line-soft bg-bg-panel p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">{card.k}</p>
                      <p className="mt-1 font-mono text-[12px] text-text">{card.v}</p>
                      <p className="text-[11px] text-text-faint">{card.sub}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-[760px] space-y-0 px-4 py-6">
                {activeThread.messages.map(m => (
                  <div key={m.id} className={`group flex gap-3 py-4 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {m.role === 'assistant' && (
                      <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full border border-line-soft bg-bg-panel text-text-dim">
                        {(() => { const I = MODELS.find(x=>x.id===m.model)?.Icon ?? CodexIcon; return <I size={13} /> })()}
                      </span>
                    )}
                    <div className={`max-w-[78%] rounded-[12px] border px-3.5 py-3 ${m.role === 'user' ? 'border-line bg-[#1c1c1f] text-text' : 'border-line-soft bg-bg-panel text-text'}`}>
                      {m.role === 'assistant' && m.content === '' ? (
                        <span className="inline-flex items-center gap-2 text-[12px] text-text-faint"><Square size={10} className="animate-pulse" /> Отправлено в CLI <code className="font-mono">{m.model ? MODEL_COMMAND[m.model] : MODEL_COMMAND[model]}</code> — жду ответ…</span>
                      ) : (
                        <MessageContent text={m.content} />
                      )}
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[11px] text-text-faint">{new Date(m.at).toLocaleTimeString()}</span>
                        {m.role === 'assistant' && m.content && (
                          <button
                            onClick={async () => { try { await navigator.clipboard.writeText(m.content) } catch {} }}
                            className="opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 text-[11px] text-text-faint hover:bg-bg-hover hover:text-text"
                          >
                            Copy
                          </button>
                        )}
                      </div>
                    </div>
                    {m.role === 'user' && (
                      <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full bg-accent text-[11px] font-semibold text-bg">You</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-line-soft bg-[#121214] p-3">
            <div className="mx-auto max-w-[760px]">
              <div className="rounded-[12px] border border-line bg-bg-panel shadow-[0_8px_30px_rgba(0,0,0,0.35)] focus-within:border-line">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                  }}
                  rows={1}
                  placeholder={`Message ${MODELS.find(m=>m.id===model)?.label} — уйдёт в CLI ${MODEL_COMMAND[model]} (Shift+Enter перенос)`}
                  className="max-h-[140px] min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 text-[13px] text-text placeholder:text-text-faint outline-none"
                  style={{ height: 'auto' }}
                  onInput={e => {
                    const el = e.target as HTMLTextAreaElement
                    el.style.height = 'auto'
                    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
                  }}
                />
                <div className="flex items-center justify-between gap-2 border-t border-line-soft px-2 py-2">
                  <div className="flex items-center gap-1">
                    <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-line-soft bg-bg-raise px-2 py-1 text-[11px] text-text-faint">
                      <Wrench size={11} /> CLI: {MODEL_COMMAND[model]}
                    </span>
                  </div>
                  <button
                    onClick={() => void send()}
                    disabled={!input.trim()}
                    className="flex items-center gap-1.5 rounded-[8px] bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-bg hover:opacity-90 disabled:opacity-40"
                  >
                    <Send size={13} /> Send to CLI
                  </button>
                </div>
              </div>
              <p className="mt-2 text-center text-[11px] text-text-faint">
                Вид Codex, без встроенного мока — всё через твой CLI, отображение в чате.
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
