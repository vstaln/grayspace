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
  FileCode,
  Wrench,
  Loader2
} from 'lucide-react'
import CodexIcon from './CodexIcon'
import ClaudeIcon from './ClaudeIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import OpenCodeIcon from './OpenCodeIcon'
import { renderMarkdownSafe } from '../lib/markdown'
import type { ChatModelId } from '../../../preload/index.d'

type ChatModel = ChatModelId

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  model?: ChatModel
  at: number
  isStreaming?: boolean
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
  { id: 'opencode', label: 'OpenCode', Icon: OpenCodeIcon, desc: 'Local' }
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
    // Clean up any dangling isStreaming flags from past sessions
    return parsed.slice(0, 50).map((t) => ({
      ...t,
      messages: (t.messages || []).map((m) => ({ ...m, isStreaming: false }))
    }))
  } catch {
    return []
  }
}

function saveThreads(threads: ChatThread[]): void {
  try {
    const sanitized = threads.slice(0, 50).map((t) => ({
      ...t,
      messages: t.messages.map(({ isStreaming: _s, ...m }) => m)
    }))
    localStorage.setItem(LS_KEY, JSON.stringify(sanitized))
  } catch {}
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

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

interface Props {
  active: boolean
}

export default function ChatPane({ active }: Props): React.JSX.Element {
  const [threads, setThreads] = useState<ChatThread[]>(() => loadThreads())
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => threads[0]?.id ?? null)
  const [model, setModel] = useState<ChatModel>(() => threads[0]?.model ?? 'codex')
  const [query, setQuery] = useState('')
  const [input, setInput] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [runningThreads, setRunningThreads] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  )

  const isGenerating = Boolean(activeThreadId && runningThreads.has(activeThreadId))

  useEffect(() => {
    saveThreads(threads)
  }, [threads])

  useEffect(() => {
    if (!active) return
    setTimeout(() => inputRef.current?.focus(), 80)
  }, [active])

  // Sync model with active thread when switching
  useEffect(() => {
    if (activeThread?.model) {
      setModel(activeThread.model)
    }
  }, [activeThreadId, activeThread?.model])

  // Auto-scroll on messages change or active thread switch
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [activeThreadId, activeThread?.messages.length, isGenerating])

  // Subscribe to chat stream data and exit events from window.api.chat
  useEffect(() => {
    if (!window.api?.chat) return

    const offData = window.api.chat.onData((threadId: string, chunk: string) => {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t
          const msgs = [...t.messages]
          const lastIdx = msgs.findLastIndex((m) => m.role === 'assistant')
          if (lastIdx !== -1) {
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              content: msgs[lastIdx].content + chunk,
              isStreaming: true
            }
          }
          return { ...t, messages: msgs, at: Date.now() }
        })
      )
      // Scroll down during streaming
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight
      }
    })

    const offExit = window.api.chat.onExit(
      (threadId: string, payload: { exitCode: number; cancelled?: boolean; timedOut?: boolean }) => {
        setRunningThreads((prev) => {
          const next = new Set(prev)
          next.delete(threadId)
          return next
        })
        setThreads((prev) =>
          prev.map((t) => {
            if (t.id !== threadId) return t
            const msgs = [...t.messages]
            const lastIdx = msgs.findLastIndex((m) => m.role === 'assistant')
            if (lastIdx !== -1) {
              let extra = ''
              if (payload.cancelled) {
                extra = msgs[lastIdx].content ? '\n\n_[Stopped by user]_' : '[Stopped by user]'
              } else if (payload.timedOut) {
                extra = '\n\n_[Request timed out]_'
              } else if (payload.exitCode !== 0 && !msgs[lastIdx].content.trim()) {
                extra = `[Process exited with code ${payload.exitCode}]`
              }
              msgs[lastIdx] = {
                ...msgs[lastIdx],
                content: msgs[lastIdx].content + extra,
                isStreaming: false
              }
            }
            return { ...t, messages: msgs, at: Date.now() }
          })
        )
      }
    )

    return () => {
      offData()
      offExit()
    }
  }, [])

  const createThread = useCallback(
    (initialModel: ChatModel = model) => {
      const t: ChatThread = {
        id: makeId(),
        title: 'New chat',
        model: initialModel,
        messages: [],
        at: Date.now()
      }
      setThreads((prev) => [t, ...prev])
      setActiveThreadId(t.id)
      setModel(initialModel)
      setTimeout(() => inputRef.current?.focus(), 50)
    },
    [model]
  )

  const deleteThread = useCallback(
    (id: string) => {
      void window.api?.chat?.dispose(id).catch(() => {})
      setRunningThreads((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setThreads((prev) => {
        const next = prev.filter((t) => t.id !== id)
        if (activeThreadId === id) setActiveThreadId(next[0]?.id ?? null)
        return next
      })
    },
    [activeThreadId]
  )

  const stopCurrent = useCallback(() => {
    if (!activeThreadId) return
    void window.api?.chat?.stop(activeThreadId).catch(() => {})
  }, [activeThreadId])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || isGenerating) return

    let threadId = activeThreadId
    let threadModel = model
    if (!threadId) {
      const t: ChatThread = {
        id: makeId(),
        title: text.slice(0, 36) || 'New chat',
        model,
        messages: [],
        at: Date.now()
      }
      threadId = t.id
      threadModel = t.model
      setThreads((prev) => [t, ...prev])
      setActiveThreadId(t.id)
    }

    const userMsg: ChatMessage = { id: makeId(), role: 'user', content: text, at: Date.now() }
    const assistantId = makeId()
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      model: threadModel,
      at: Date.now(),
      isStreaming: true
    }

    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'

    setRunningThreads((prev) => new Set(prev).add(threadId!))
    setThreads((prev) =>
      prev.map((t) =>
        t.id === threadId
          ? {
              ...t,
              title: t.messages.length === 0 ? text.slice(0, 36) : t.title,
              model: threadModel,
              messages: [...t.messages, userMsg, assistantPlaceholder],
              at: Date.now()
            }
          : t
      )
    )

    try {
      const result = await window.api.chat.send(threadId, threadModel, text)
      if (result && 'error' in result) {
        setRunningThreads((prev) => {
          const next = new Set(prev)
          next.delete(threadId!)
          return next
        })
        setThreads((prev) =>
          prev.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  messages: t.messages.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          content: `[Failed to start CLI: ${result.error}]`,
                          isStreaming: false
                        }
                      : m
                  )
                }
              : t
          )
        )
      }
    } catch (err) {
      setRunningThreads((prev) => {
        const next = new Set(prev)
        next.delete(threadId!)
        return next
      })
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: `[Error: ${err instanceof Error ? err.message : String(err)}]`,
                        isStreaming: false
                      }
                    : m
                )
              }
            : t
        )
      )
    }

    setTimeout(() => inputRef.current?.focus(), 30)
  }, [input, isGenerating, activeThreadId, model])

  const selectModel = useCallback(
    (newModel: ChatModel) => {
      setModel(newModel)
      if (activeThreadId) {
        setThreads((prev) =>
          prev.map((t) => (t.id === activeThreadId ? { ...t, model: newModel } : t))
        )
      }
    },
    [activeThreadId]
  )

  const filtered = useMemo(() => {
    if (!query.trim()) return threads
    const q = query.toLowerCase()
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.messages.some((m) => m.content.toLowerCase().includes(q))
    )
  }, [threads, query])

  const ModelIcon = MODELS.find((m) => m.id === model)?.Icon ?? CodexIcon

  return (
    <div
      className={`absolute inset-y-0 right-0 left-rail z-[40000] flex flex-col bg-[#0a0a0b] pt-10 ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      aria-hidden={!active}
    >
      <div className="flex h-9 flex-none items-center justify-between gap-2 border-b border-line-soft bg-bg-panel px-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="grid h-7 w-7 place-items-center rounded-[6px] text-text-faint hover:bg-bg-hover hover:text-text"
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-text">
            <Sparkles size={14} className="text-accent" /> Chat
            <span className="hidden sm:inline font-normal text-text-faint">— Agent CLI Runner</span>
          </span>
          <span className="hidden md:flex items-center gap-1 rounded-full border border-line-soft bg-bg-raise px-2 py-0.5 text-[11px] text-text-faint">
            <ModelIcon size={12} /> {MODELS.find((m) => m.id === model)?.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="hidden sm:flex items-center gap-1 rounded-full border border-line-soft bg-bg-raise p-[2px]">
            {MODELS.map((m) => {
              const isActive = m.id === model
              return (
                <button
                  key={m.id}
                  onClick={() => selectModel(m.id)}
                  title={`${m.label} — ${m.desc}`}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    isActive ? 'bg-[#2a2a2e] text-[#ececec]' : 'text-text-faint hover:text-text'
                  }`}
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
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chats"
                  className="h-8 w-full rounded-[8px] border border-line-soft bg-bg-raise pl-8 pr-2.5 text-[12px] text-text placeholder:text-text-faint outline-none focus:border-line"
                />
              </label>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {filtered.length === 0 ? (
                <div className="px-2 py-8 text-center text-[12px] text-text-faint">
                  No chats yet.
                  <br />
                  Start with Codex or Claude.
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                      Recents
                    </p>
                    <div className="space-y-1">
                      {filtered.map((t) => {
                        const isActive = t.id === activeThreadId
                        const preview =
                          t.messages[t.messages.length - 1]?.content.slice(0, 64) || 'No messages yet'
                        const MIcon = MODELS.find((m) => m.id === t.model)?.Icon ?? Sparkles
                        const running = runningThreads.has(t.id)
                        return (
                          <button
                            key={t.id}
                            onClick={() => setActiveThreadId(t.id)}
                            className={`group flex w-full flex-col gap-1 rounded-[8px] border px-2.5 py-2 text-left transition-colors ${
                              isActive
                                ? 'border-line bg-bg-hover text-text'
                                : 'border-transparent bg-transparent text-text hover:bg-bg-hover/60 hover:text-text'
                            }`}
                          >
                            <span className="flex w-full items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                                <span className="grid h-5 w-5 place-items-center rounded-[6px] border border-line-soft bg-bg-raise text-text-faint">
                                  {running ? (
                                    <Loader2 size={11} className="animate-spin text-accent" />
                                  ) : (
                                    <MIcon size={11} />
                                  )}
                                </span>
                                <span className="truncate">{t.title}</span>
                              </span>
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  deleteThread(t.id)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.stopPropagation()
                                    deleteThread(t.id)
                                  }
                                }}
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
            <div className="border-t border-line-soft p-2.5 text-[11px] text-text-faint">
              <span className="flex items-center gap-1">
                <Wrench size={11} /> Headless CLI Engine
              </span>
              <span className="mt-0.5 block text-[10px] leading-tight text-text-dim">
                Executes via <code className="font-mono text-accent">{MODEL_COMMAND[model]}</code> with streaming output
              </span>
            </div>
          </aside>
        )}

        <main className="flex min-h-0 flex-1 flex-col bg-[#0a0a0b]">
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {!activeThread || activeThread.messages.length === 0 ? (
              <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-10">
                <div className="rounded-[12px] border border-line-soft bg-bg-panel p-5">
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold text-text">
                    <ModelIcon size={16} /> {MODELS.find((m) => m.id === model)?.label} Assistant
                  </h2>
                  <p className="mt-1.5 text-[13px] leading-[1.6] text-text-dim">
                    Direct integration with your installed agent CLI{' '}
                    <code className="rounded bg-bg-raise px-1.5 py-0.5 text-text font-mono">
                      {MODEL_COMMAND[model]}
                    </code>
                    . One-shot execution with frame-rate streaming and zero hanging background processes.
                  </p>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {[
                      'Explain the architecture of OrcSpace',
                      'Review the recent changes in src/main',
                      'Write a test for the chat runner',
                      'Inspect Git status and diff'
                    ].map((prompt) => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setInput(prompt)
                          setTimeout(() => inputRef.current?.focus(), 0)
                        }}
                        className="rounded-[10px] border border-line-soft bg-bg-raise px-3 py-2.5 text-left text-[12px] leading-[1.45] text-text-dim hover:bg-bg-hover hover:text-text transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { k: 'Engine', v: MODEL_COMMAND[model], sub: 'Headless CLI Process' },
                    { k: 'Stream', v: '16 ms flush', sub: 'Native Rust ANSI Stripping' },
                    { k: 'State', v: 'Isolated', sub: 'Per-thread lifecycle' }
                  ].map((card) => (
                    <div key={card.k} className="rounded-[10px] border border-line-soft bg-bg-panel p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                        {card.k}
                      </p>
                      <p className="mt-1 font-mono text-[12px] text-text">{card.v}</p>
                      <p className="text-[11px] text-text-faint">{card.sub}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-[760px] space-y-0 px-4 py-6">
                {activeThread.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`group flex gap-3 py-4 ${
                      m.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    {m.role === 'assistant' && (
                      <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full border border-line-soft bg-bg-panel text-text-dim">
                        {(() => {
                          const I = MODELS.find((x) => x.id === m.model)?.Icon ?? CodexIcon
                          return <I size={13} />
                        })()}
                      </span>
                    )}
                    <div
                      className={`max-w-[78%] rounded-[12px] border px-3.5 py-3 ${
                        m.role === 'user'
                          ? 'border-line bg-[#1c1c1f] text-text'
                          : 'border-line-soft bg-bg-panel text-text'
                      }`}
                    >
                      {m.role === 'assistant' && m.content === '' && m.isStreaming ? (
                        <span className="inline-flex items-center gap-2 text-[12px] text-text-faint">
                          <Loader2 size={12} className="animate-spin text-accent" />
                          Running <code className="font-mono">{MODEL_COMMAND[m.model || model]}</code> — waiting for output…
                        </span>
                      ) : (
                        <MessageContent text={m.content} />
                      )}
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[11px] text-text-faint">
                          {new Date(m.at).toLocaleTimeString()}
                        </span>
                        {m.role === 'assistant' && m.content && (
                          <div className="flex items-center gap-2">
                            {m.isStreaming && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-accent">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                                streaming
                              </span>
                            )}
                            <button
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(m.content)
                                } catch {}
                              }}
                              className="opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 text-[11px] text-text-faint hover:bg-bg-hover hover:text-text transition-opacity"
                            >
                              Copy
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {m.role === 'user' && (
                      <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full bg-accent text-[11px] font-semibold text-bg">
                        You
                      </span>
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
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                  rows={1}
                  placeholder={
                    isGenerating
                      ? `Generating response from ${MODEL_COMMAND[model]}…`
                      : `Message ${MODELS.find((m) => m.id === model)?.label} (${MODEL_COMMAND[model]}) — Shift+Enter for new line`
                  }
                  disabled={isGenerating}
                  className="max-h-[140px] min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 text-[13px] text-text placeholder:text-text-faint outline-none disabled:opacity-60"
                  style={{ height: 'auto' }}
                  onInput={(e) => {
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
                  <div className="flex items-center gap-1.5">
                    {isGenerating ? (
                      <button
                        onClick={stopCurrent}
                        className="flex items-center gap-1.5 rounded-[8px] bg-red-600/80 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-red-600 transition-colors"
                      >
                        <Square size={12} fill="currentColor" /> Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => void send()}
                        disabled={!input.trim()}
                        className="flex items-center gap-1.5 rounded-[8px] bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-bg hover:opacity-90 disabled:opacity-40 transition-opacity"
                      >
                        <Send size={13} /> Send
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <p className="mt-2 text-center text-[11px] text-text-faint">
                Runs locally against your installed CLI in headless mode with real-time stream rendering.
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
