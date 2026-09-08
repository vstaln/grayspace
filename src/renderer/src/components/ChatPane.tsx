import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  Loader2,
  ChevronDown,
  Terminal
} from 'lucide-react'
import CodexIcon from './CodexIcon'
import ClaudeIcon from './ClaudeIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import OpenCodeIcon from './OpenCodeIcon'
import CursorIcon from './CursorIcon'
import { renderMarkdownSafe } from '../lib/markdown'
import { insertAt, pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { useConfirm } from './ConfirmDialog'
import type { ChatModelId, ChatEffort, ChatModelCatalog } from '../../../preload/index.d'
import type { MediaFile } from '../../../preload/index.d'

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
  modelName?: string
  effort?: ChatEffort
  customCommand?: string
  messages: ChatMessage[]
  at: number
}

const MODELS: { id: ChatModel; label: string; Icon: React.ComponentType<{ size?: number }>; desc: string }[] = [
  { id: 'codex', label: 'Codex', Icon: CodexIcon, desc: 'Code + review' },
  { id: 'claude', label: 'Claude', Icon: ClaudeIcon, desc: 'Reasoning' },
  { id: 'antigravity', label: 'Antigravity', Icon: AntigravityIcon, desc: 'Research' },
  { id: 'grok', label: 'Grok', Icon: GrokIcon, desc: 'Fast' },
  { id: 'opencode', label: 'OpenCode', Icon: OpenCodeIcon, desc: 'Local' },
  { id: 'gemini', label: 'Gemini CLI', Icon: Terminal, desc: 'Google CLI' },
  { id: 'cursor', label: 'Cursor', Icon: CursorIcon, desc: 'Cursor Agent' },
  { id: 'aider', label: 'Aider', Icon: Terminal, desc: 'Git pair programmer' },
  { id: 'custom', label: 'Other CLI', Icon: Terminal, desc: 'Custom command' }
]

const MODEL_OPTIONS: Record<ChatModel, string[]> = {
  codex: ['gpt-5.6-luna'],
  claude: ['claude-sonnet-5'],
  grok: ['grok-4.6'],
  antigravity: ['gemini-3.7-flash-medium'],
  opencode: ['opencode/big-pickle'],
  gemini: ['gemini-2.5-pro'],
  cursor: ['auto'],
  aider: ['default'],
  custom: []
}
const EFFORT_OPTIONS: Record<ChatModel, ChatEffort[]> = {
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: ['low', 'medium', 'high'],
  opencode: ['minimal', 'low', 'medium', 'high', 'max'],
  gemini: [],
  cursor: [],
  aider: [],
  custom: []
}
function modelsFor(catalog: ChatModelCatalog, provider: ChatModel): string[] {
  const discovered = catalog[provider]?.models.map((entry) => entry.id).filter(Boolean) ?? []
  return discovered.length ? discovered : MODEL_OPTIONS[provider]
}
function preferredModel(catalog: ChatModelCatalog, provider: ChatModel): string {
  const options = modelsFor(catalog, provider)
  if (options.length === 0) return ''
  const preferred = MODEL_OPTIONS[provider][0]
  if (options.includes(preferred)) return preferred
  const configured = catalog[provider]?.defaultModel
  return configured && options.includes(configured) ? configured : options[0]
}
function defaultEffort(forModel: ChatModel): ChatEffort | undefined {
  return EFFORT_OPTIONS[forModel][1] ?? EFFORT_OPTIONS[forModel][0]
}
function preferredEffort(catalog: ChatModelCatalog, provider: ChatModel, selectedModel: string): ChatEffort | undefined {
  const options = effortOptionsFor(catalog, provider, selectedModel)
  if (provider === 'codex' && options.includes('medium')) return 'medium'
  return catalog[provider]?.defaultEffort && options.includes(catalog[provider].defaultEffort)
    ? catalog[provider].defaultEffort
    : options[0]
}
function effortOptionsFor(catalog: ChatModelCatalog, provider: ChatModel, selectedModel: string): ChatEffort[] {
  return catalog[provider]?.models.find((entry) => entry.id === selectedModel)?.efforts ?? EFFORT_OPTIONS[provider]
}

const MODEL_COMMAND: Record<ChatModel, string> = {
  codex: 'codex',
  claude: 'claude',
  grok: 'grok',
  antigravity: 'agy',
  opencode: 'opencode',
  gemini: 'gemini',
  cursor: 'cursor-agent',
  aider: 'aider',
  custom: 'custom CLI'
}

function commandFor(model: ChatModel, customCommand?: string): string {
  if (model !== 'custom') return MODEL_COMMAND[model]
  return customCommand?.trim().split(/\s+/, 1)[0] || 'custom CLI'
}

const LS_KEY = 'orcspace-chat-threads-v1'

function loadThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ChatThread[]
    if (!Array.isArray(parsed)) return []
    // Treat localStorage as untrusted: one malformed entry must not discard
    // every otherwise healthy conversation or crash the whole Chat pane.
    return parsed.slice(0, 50).flatMap((t) => {
      if (!t || typeof t !== 'object' || typeof t.id !== 'string' || typeof t.title !== 'string' || !Array.isArray(t.messages)) return []
      const model = MODELS.some((entry) => entry.id === t.model) ? t.model : 'codex'
      const messages = t.messages.flatMap((m) => {
        if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || typeof m.at !== 'number') return []
        const messageModel = typeof m.model === 'string' && MODELS.some((entry) => entry.id === m.model) ? m.model : model
        return [{ ...m, model: messageModel, isStreaming: false }]
      })
      return [{
        ...t,
        model,
        title: t.title.slice(0, 200),
        modelName: typeof t.modelName === 'string' ? t.modelName.slice(0, 128) : undefined,
        messages
      }]
    })
  } catch {
    return []
  }
}

function saveThreads(threads: ChatThread[]): void {
  try {
    const sanitized = threads.slice(0, 50).map((t) => ({
      ...t,
      // Cap per-thread history to avoid quota blow-up (was unbounded — a long chat could exceed 5MB and silently lose all threads).
      messages: t.messages.slice(-120).map(({ isStreaming: _s, ...m }) => ({ ...m, content: m.content.slice(0, 48_000) }))
    }))
    const payload = JSON.stringify(sanitized)
    // Guard against localStorage quota (typically 5-10MB) — leave 256KB headroom.
    if (payload.length > 4_500_000) {
      const trimmed = sanitized.map((t) => ({ ...t, messages: t.messages.slice(-40) }))
      localStorage.setItem(LS_KEY, JSON.stringify(trimmed))
      return
    }
    localStorage.setItem(LS_KEY, payload)
  } catch {}
}

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

const MessageContent = React.memo(function MessageContent({ text }: { text: string }): React.JSX.Element {
  const parts = useMemo(() => {
    const src = text
    const segs: { type: 'text' | 'code'; value: string; lang?: string }[] = []
    const re = /```(\w*)\n?([\s\S]*?)```/g
    let last = 0
    let m: RegExpExecArray | null
    // Cap parsing at 80k chars to avoid hangs on huge streamed answers (was unbounded).
    const capped = src.length > 80_000 ? src.slice(0, 80_000) + '\n\n_[truncated]_' : src
    while ((m = re.exec(capped)) !== null) {
      if (m.index > last) segs.push({ type: 'text', value: capped.slice(last, m.index) })
      segs.push({ type: 'code', value: m[2], lang: m[1] || 'txt' })
      last = m.index + m[0].length
    }
    if (last < capped.length) segs.push({ type: 'text', value: capped.slice(last) })
    if (segs.length === 0) segs.push({ type: 'text', value: capped })
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
})

const CodeBlock = React.memo(function CodeBlock({ code, lang }: { code: string; lang?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1200)
    } catch {}
  }, [code])
  return (
    <div className="overflow-hidden rounded-[8px] border border-line-soft bg-[#0f0f11]">
      <div className="flex h-7 items-center justify-between border-b border-line-soft bg-bg-raise px-2.5">
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
})

function ChatSelect<T extends string>({
  value,
  options,
  onChange,
  title,
  className = ''
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  title: string
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  // Flip to top if near viewport top (was always bottom, could overflow off-screen — UI bug).
  const [dropUp, setDropUp] = useState(true)
  useEffect(() => {
    if (!open || !rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    setDropUp(rect.top > 220)
  }, [open])
  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-7 w-full min-w-0 items-center justify-between gap-1 rounded-[7px] border border-transparent bg-transparent px-2 text-[11px] text-text-faint outline-none transition-colors hover:border-line-soft hover:bg-bg-hover hover:text-text"
      >
        <span className="truncate font-medium">{selected?.label || value}</span>
        <ChevronDown size={12} className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
        className={`absolute left-0 z-[70000] max-h-64 min-w-full overflow-y-auto rounded-[9px] border border-line bg-bg-panel p-1 shadow-[0_14px_40px_rgba(8,9,11,0.7)] ${dropUp ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'}`}
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={`flex w-full items-center justify-between gap-3 whitespace-nowrap rounded-[6px] px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                option.value === value ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover/70 hover:text-text'
              }`}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={12} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ThinkingIndicator({ command }: { command: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 text-[12px] text-text-faint">
      <Loader2 size={12} className="animate-spin text-accent" />
      <span>Thinking with <code className="font-mono text-text">{command}</code>…</span>
    </span>
  )
}

interface Props {
  active: boolean
}

interface MissionDraft {
  request: string
  title: string
}

interface QueuedDraft {
  text: string
  image: MediaFile | null
}

function SidebarPortal({
  target,
  children
}: {
  target: HTMLElement | null
  children: React.ReactNode
}): React.JSX.Element {
  return target ? createPortal(children, target) : <>{children}</>
}

export default function ChatPane({ active }: Props): React.JSX.Element {
  const confirm = useConfirm()
  const [threads, setThreads] = useState<ChatThread[]>(() => loadThreads())
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => threads[0]?.id ?? null)
  const [model, setModel] = useState<ChatModel>(() => threads[0]?.model ?? 'codex')
  const [modelName, setModelName] = useState(() => threads[0]?.modelName ?? MODEL_OPTIONS[threads[0]?.model ?? 'codex'][0])
  const [effort, setEffort] = useState<ChatEffort | undefined>(() => threads[0]?.effort ?? defaultEffort(threads[0]?.model ?? 'codex'))
  const [customCommand, setCustomCommand] = useState(() => threads[0]?.customCommand ?? '')
  const [modelCatalog, setModelCatalog] = useState<ChatModelCatalog>({})
  const [query, setQuery] = useState('')
  const [input, setInput] = useState('')
  const [pendingImage, setPendingImage] = useState<MediaFile | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  // Ephemeral composer errors (e.g. overlong prompt) — never written into threads.
  const [promptError, setPromptError] = useState<string | null>(null)
  // A message typed while a reply is still streaming — auto-sent when it ends.
  const [queued, setQueued] = useState<QueuedDraft | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sharedSidebarTarget, setSharedSidebarTarget] = useState<HTMLElement | null>(null)
  const [runningThreads, setRunningThreads] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const chatPinnedToBottomRef = useRef(true)
  const sendInFlightRef = useRef(false)
  const pasteSeqRef = useRef(0)
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const missionDraftsRef = useRef(new Map<string, MissionDraft>())
  const missionRunsRef = useRef(new Map<string, { taskId: string; planId: string }>())
  const missionSettledRef = useRef(new Set<string>())

  const startMission = useCallback(async (draft: MissionDraft, codexPlan: string): Promise<void> => {
    const plan = codexPlan.trim().slice(0, 12_000) || 'Codex returned no plan. Inspect the request and make the smallest safe implementation.'
    const title = draft.title.slice(0, 180)
    const item = await window.api.planner.create({
      title,
      project: 'Mission',
      note: `Codex plan:\n${plan.slice(0, 3_700)}\n\nOriginal request:\n${draft.request.slice(0, 250)}`
    })
    if (!item || 'error' in item) return
    const started = await window.api.mission.start({
      objective: draft.request,
      title,
      spec: plan,
      planId: item.id
    })
    if (!started || 'error' in started) {
      await window.api.planner.update(item.id, {
        note: `Mission could not start: ${started && 'error' in started ? started.error : 'unknown error'}\n\nCodex plan:\n${plan.slice(0, 3_700)}`
      }).catch(() => {})
      return
    }
    missionRunsRef.current.set(started.runId, { taskId: started.taskId, planId: item.id })
    window.dispatchEvent(new CustomEvent('orcspace:mission-start', {
      detail: { missionId: started.runId, planId: item.id, title, terminalId: started.terminalId }
    }))
    window.dispatchEvent(new CustomEvent('orcspace:mission-view', { detail: { view: 'canvas' } }))
  }, [])

  // The worker reports completion through the normal orchestration store. Tie
  // that lifecycle back to the one Planner item created for this mission.
  useEffect(() => {
    const off = window.api.orchestration.onChange(() => {
      for (const [runId, mission] of missionRunsRef.current) {
        if (missionSettledRef.current.has(runId)) continue
        void window.api.orchestration.snapshot(runId).then((snapshot) => {
          const task = snapshot.tasks.find((candidate) => candidate.id === mission.taskId)
          if (!task || (task.status !== 'completed' && task.status !== 'failed')) return
          missionSettledRef.current.add(runId)
          if (task.status === 'completed') {
            void window.api.planner.toggle(mission.planId, true)
          }
          window.dispatchEvent(new CustomEvent('orcspace:mission-complete', {
            detail: { missionId: runId, success: task.status === 'completed' }
          }))
          if (task.status === 'completed') {
            window.dispatchEvent(new CustomEvent('orcspace:mission-view', { detail: { view: 'chat' } }))
          }
          missionRunsRef.current.delete(runId)
        }).catch(() => {})
      }
    })
    return off
  }, [])

  useEffect(() => {
    if (!active) {
      setSharedSidebarTarget(null)
      return
    }
    setSharedSidebarTarget(document.querySelector<HTMLElement>('[data-chat-sidebar-slot]'))
  }, [active])

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  )

  const isGenerating = Boolean(activeThreadId && runningThreads.has(activeThreadId))
  const modelSelectOptions = modelsFor(modelCatalog, model)
  const configuredEfforts = effortOptionsFor(modelCatalog, model, modelName)
  const contextPercent = useMemo(() => {
    if (!activeThread) return 0
    // Rough token estimate: ~4 chars per token, 128k context → show char-based % with clamp, not /320 magic (was wildly jumping).
    const chars = activeThread.messages.reduce((total, message) => total + message.content.length, 0)
    const estTokens = chars / 4
    return Math.min(99, Math.round((estTokens / 128_000) * 100))
  }, [activeThread])

  useEffect(() => {
    const timer = window.setTimeout(() => saveThreads(threads), 250)
    return () => window.clearTimeout(timer)
  }, [threads])

  useEffect(() => {
    let mounted = true
    const modelLoader = typeof window.api.chat.listModels === 'function'
      ? window.api.chat.listModels()
      : Promise.resolve<ChatModelCatalog>({})
    void modelLoader.then((catalog) => {
      if (mounted && catalog && typeof catalog === 'object') {
        setModelCatalog(catalog)
        setThreads((current) => current.map((thread) => {
          const availableModels = modelsFor(catalog, thread.model)
          const nextModelName = thread.modelName && availableModels.includes(thread.modelName)
            ? thread.modelName
            : preferredModel(catalog, thread.model)
          const availableEfforts = effortOptionsFor(catalog, thread.model, nextModelName)
          const nextEffort = thread.effort && availableEfforts.includes(thread.effort)
            ? thread.effort
            : preferredEffort(catalog, thread.model, nextModelName)
          return { ...thread, modelName: nextModelName, effort: nextEffort }
        }))

        // Only reconcile global picker if user hasn't already switched thread/model
        // (avoid overwriting a choice made while catalog was loading).
        setModel((prevModel) => {
          const catalogModels = catalog[prevModel]?.models
          if (!catalogModels?.length) return prevModel
          return prevModel
        })
      }
    }).catch(() => {
      // Static safe defaults remain available when a CLI has no local settings.
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!active) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 80)
    return () => window.clearTimeout(t)
  }, [active])

  // Sync model with active thread when switching
  useEffect(() => {
    if (activeThread?.model) {
      setModel(activeThread.model)
      const availableModels = modelsFor(modelCatalog, activeThread.model)
      const nextModelName = activeThread.modelName && availableModels.includes(activeThread.modelName)
        ? activeThread.modelName
        : preferredModel(modelCatalog, activeThread.model)
      const availableEfforts = effortOptionsFor(modelCatalog, activeThread.model, nextModelName)
      setModelName(nextModelName)
      setEffort(activeThread.effort && availableEfforts.includes(activeThread.effort)
        ? activeThread.effort
        : preferredEffort(modelCatalog, activeThread.model, nextModelName))
      setCustomCommand(activeThread.customCommand ?? '')
    }
  }, [activeThreadId, activeThread?.model, activeThread?.modelName, activeThread?.effort, activeThread?.customCommand, modelCatalog])

  // A thread switch starts at its newest message. During streaming, preserve
  // the reader's viewport once they deliberately scroll away from the bottom.
  useEffect(() => {
    chatPinnedToBottomRef.current = true
    const raf = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [activeThreadId])

  useEffect(() => {
    if (!chatPinnedToBottomRef.current) return
    const raf = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [activeThread?.messages.length, isGenerating])

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
            const MAX_STREAM_CHARS = 180_000
            const nextContent = msgs[lastIdx].content + chunk
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              content: nextContent.length > MAX_STREAM_CHARS
                ? nextContent.slice(0, MAX_STREAM_CHARS) + '\n\n_[truncated — exceeded 180k chars]_'
                : nextContent,
              isStreaming: true
            }
          }
          return { ...t, messages: msgs, at: Date.now() }
        })
      )
      if (chatPinnedToBottomRef.current) requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
      })
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

        const missionDraft = missionDraftsRef.current.get(threadId)
        if (missionDraft) {
          missionDraftsRef.current.delete(threadId)
          if (payload.exitCode === 0 && !payload.cancelled && !payload.timedOut) {
            const thread = threadsRef.current.find((candidate) => candidate.id === threadId)
            const assistantPlan = thread?.messages.slice().reverse().find((message) => message.role === 'assistant')?.content ?? ''
            void startMission(missionDraft, assistantPlan)
          }
        }
      }
    )

    return () => {
      offData()
      offExit()
    }
  }, [startMission])

  const createThread = useCallback(
    (initialModel: ChatModel = model) => {
      const t: ChatThread = {
        id: makeId(),
        title: 'New chat',
        model: initialModel,
        modelName: preferredModel(modelCatalog, initialModel),
        effort: preferredEffort(modelCatalog, initialModel, preferredModel(modelCatalog, initialModel)) ?? defaultEffort(initialModel),
        customCommand: initialModel === 'custom' ? customCommand : undefined,
        messages: [],
        at: Date.now()
      }
      setThreads((prev) => [t, ...prev])
      setActiveThreadId(t.id)
      setModel(initialModel)
      const tId = window.setTimeout(() => inputRef.current?.focus(), 50)
      // Timer intentionally short; clear on unmount via effect not needed — one-shot focus.
      void tId
    },
    [model, modelCatalog, customCommand]
  )

  const deleteThread = useCallback(
    (id: string): void => {
      const thread = threads.find((t) => t.id === id)
      const label = thread?.title ? `"${thread.title.slice(0, 40)}"` : 'this chat'
      void confirm(`Delete ${label}? This cannot be undone.`, {
        danger: true,
        title: 'Delete chat',
        confirmLabel: 'Delete'
      }).then((ok) => {
        if (!ok) return
        void window.api?.chat?.dispose(id).catch(() => {})
        setRunningThreads((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        // Compute the fallback outside the updater: calling another setter
        // from inside an updater is impure (updaters may re-run) — and
        // `threads` is already a dep of this callback, so it is current here.
        const remaining = threads.filter((t) => t.id !== id)
        setThreads(remaining)
        setActiveThreadId((current) => (current === id ? remaining[0]?.id ?? null : current))
      })
    },
    [confirm, threads]
  )

  useEffect(() => {
    const createFromSidebar = (): void => createThread()
    window.addEventListener('orcspace:new-chat', createFromSidebar)
    return () => window.removeEventListener('orcspace:new-chat', createFromSidebar)
  }, [createThread])

  const stopCurrent = useCallback(() => {
    if (!activeThreadId) return
    void window.api?.chat?.stop(activeThreadId).catch(() => {})
  }, [activeThreadId])

  const send = useCallback(async (override?: string, overrideImage?: MediaFile | null) => {
    const text = (override ?? input).trim()
    const image = overrideImage !== undefined ? overrideImage : (override === undefined ? pendingImage : null)
    if (!text && !image) return
    const prompt = text || 'Please analyze the attached image.'
    if (text.length > 32_000) {
      // Ephemeral inline error — the prompt is rejected without mutating threads.
      setPromptError('Prompt too long — keep it under 32,000 characters.')
      return
    }
    if (model === 'custom' && !customCommand.trim()) {
      setPromptError('Enter a CLI command. Use {prompt} where the message should be inserted.')
      return
    }
    if (sendInFlightRef.current) return
    if (isGenerating && override === undefined) {
      // Queue the draft instead of blocking it: auto-sent when the reply ends.
      setQueued((prev) => ({
        text: prev?.text ? (text ? `${prev.text}\n${text}` : prev.text) : text,
        // Keep the attachment with the queued draft. Without this, an image
        // queued during a stream was left in the composer and sent with a
        // later message (or silently dropped when the queue flushed).
        image: image ?? prev?.image ?? null
      }))
      setInput('')
      setPendingImage(null)
      setImageError(null)
      if (inputRef.current) inputRef.current.style.height = 'auto'
      return
    }
    if (isGenerating) return
    sendInFlightRef.current = true
    // A paste can still be saving its bitmap while the user presses Send.
    // Invalidate that response so an old clipboard image cannot reappear as a
    // new attachment after this message has already been sent.
    pasteSeqRef.current += 1

    let threadId = activeThreadId
    let threadModel = model
    // Mission Mode is driven by the explicit Mission Controller widget. Chat
    // remains a normal conversation even when the setting is enabled.
    const startsMission = false
    if (!threadId) {
      const t: ChatThread = {
        id: makeId(),
        title: text.slice(0, 36) || 'Image chat',
        model,
        modelName,
        effort,
        customCommand: model === 'custom' ? customCommand : undefined,
        messages: [],
        at: Date.now()
      }
      threadId = t.id
      threadModel = t.model
      setThreads((prev) => [t, ...prev])
      setActiveThreadId(t.id)
    }

    if (startsMission && threadId) {
      missionDraftsRef.current.set(threadId, {
        request: text,
        title: `Mission · ${text.slice(0, 150)}`
      })
    }

    const promptToSend = startsMission
      ? [
          'MISSION MODE: do not implement the request yet.',
          'Analyze it and return a concrete, ordered implementation plan for another worker.',
          'Include affected files, acceptance criteria, and verification commands.',
          'Keep the answer focused on the plan.',
          '',
          'USER REQUEST:',
          prompt
        ].join('\n')
      : prompt

    const userMsg: ChatMessage = { id: makeId(), role: 'user', content: text || '[Image attached]', at: Date.now() }
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
    setPendingImage(null)
    setImageError(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'

    setRunningThreads((prev) => new Set(prev).add(threadId!))
    setThreads((prev) =>
      prev.map((t) =>
        t.id === threadId
          ? {
              ...t,
              title: t.messages.length === 0 ? (text.slice(0, 36) || 'Image chat') : t.title,
              model: threadModel,
              modelName,
              effort,
              customCommand: threadModel === 'custom' ? customCommand : undefined,
              messages: [...t.messages, userMsg, assistantPlaceholder],
              at: Date.now()
            }
          : t
      )
    )

    try {
      const result = await window.api.chat.send(threadId, threadModel, promptToSend, {
        model: modelName,
        effort: effortOptionsFor(modelCatalog, threadModel, modelName).includes(effort as ChatEffort) ? effort : undefined,
        images: image ? [image.path] : undefined,
        command: threadModel === 'custom' ? customCommand : undefined
      })
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
    } finally {
      sendInFlightRef.current = false
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [input, pendingImage, isGenerating, activeThreadId, model, modelName, effort, modelCatalog, customCommand])

  // Flush a queued draft once the running reply finishes (and the thread still
  // exists) — this is what makes the composer non-blocking.
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (isGenerating || queued === null) return
    if (!activeThreadId || !threads.some((t) => t.id === activeThreadId)) return
    const q = queued
    setQueued(null)
    void sendRef.current(q.text, q.image)
  }, [isGenerating, queued, activeThreadId, threads])

  const onPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasteSeq = ++pasteSeqRef.current
    const nativeEvent = event.nativeEvent
    const hasAdvertisedImage = pasteHasImage(nativeEvent)
    const plainText = nativeEvent.clipboardData?.getData('text/plain') ?? ''
    const start = event.currentTarget.selectionStart ?? input.length
    const end = event.currentTarget.selectionEnd ?? start

    // Windows sometimes gives Chromium only an accessibility label such as
    // "Image #1" while Electron's native clipboard still contains the bitmap.
    // Check the native clipboard for every paste. If it is plain text after
    // all, reinsert it exactly where the browser would have done so.
    event.preventDefault()
    setImageError(null)
    void saveImageFromPaste(nativeEvent, { scratch: true }).then((image) => {
      if (pasteSeq !== pasteSeqRef.current) return
      if (image) {
        setPendingImage(image)
        return
      }
      if (hasAdvertisedImage) {
        setImageError('Could not read the image from the clipboard')
        return
      }
      if (plainText) {
        setInput((current) => insertAt(current, start, end, plainText).value)
        requestAnimationFrame(() => {
          const caret = start + plainText.length
          inputRef.current?.setSelectionRange(caret, caret)
        })
      }
    }).catch((error) => {
      setImageError(error instanceof Error ? error.message : 'Could not save the image')
    })
  }, [input.length])

  const selectModel = useCallback(
    (newModel: ChatModel) => {
      const nextModelName = preferredModel(modelCatalog, newModel)
      const nextEffort = preferredEffort(modelCatalog, newModel, nextModelName) ?? defaultEffort(newModel)
      setModel(newModel)
      setModelName(nextModelName)
      setEffort(nextEffort)
      if (activeThreadId) {
        setThreads((prev) =>
          prev.map((t) => (t.id === activeThreadId
            ? {
                ...t,
                model: newModel,
                modelName: nextModelName,
                effort: nextEffort,
                customCommand: newModel === 'custom' ? customCommand : undefined
              }
            : t))
        )
      }
    },
    [activeThreadId, modelCatalog, customCommand]
  )

  const updateModelName = useCallback((value: string) => {
    setModelName(value)
    if (activeThreadId) setThreads((prev) => prev.map((t) => t.id === activeThreadId ? { ...t, modelName: value } : t))
  }, [activeThreadId])

  const updateEffort = useCallback((value: string) => {
    const next = value as ChatEffort
    setEffort(next)
    if (activeThreadId) setThreads((prev) => prev.map((t) => t.id === activeThreadId ? { ...t, effort: next } : t))
  }, [activeThreadId])

  const updateCustomCommand = useCallback((value: string) => {
    const next = value.slice(0, 512)
    setCustomCommand(next)
    if (promptError) setPromptError(null)
    if (activeThreadId) {
      setThreads((prev) => prev.map((t) => t.id === activeThreadId ? { ...t, customCommand: next } : t))
    }
  }, [activeThreadId, promptError])

  const [debouncedQuery, setDebouncedQuery] = useState(query)
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 180)
    return () => window.clearTimeout(t)
  }, [query])
  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return threads
    // Cap scan per thread to last 20 messages and 2k chars to avoid hangs on long histories (was scanning all messages fully).
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.messages.slice(-20).some((m) => m.content.slice(0, 2000).toLowerCase().includes(q))
    )
  }, [threads, debouncedQuery])

  const ModelIcon = MODELS.find((m) => m.id === model)?.Icon ?? CodexIcon

  return (
    <div
      // Shared full-pane left offset: the pane is only visible when the app
      // sidebar is expanded, which is 240px in chat (see
      // geometry.sidebarExpandedChat in design/tokens.ts). Matches the
      // expanded sidebar so pane content never slides underneath it.
      className={`absolute inset-y-0 right-0 left-[240px] z-[40000] flex flex-col bg-bg pt-10 ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      aria-hidden={!active}
    >
      <style>{`@property --orc-chat-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; } @keyframes orc-chat-border-shimmer { from { --orc-chat-angle: 0deg; } to { --orc-chat-angle: 360deg; } } .orc-chat-border-shimmer { padding: 1px; background: conic-gradient(from var(--orc-chat-angle), transparent 0deg 315deg, rgba(255,255,255,.22) 332deg, rgba(255,255,255,.98) 348deg, transparent 360deg); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude; animation: orc-chat-border-shimmer 5.8s linear infinite; }`}</style>
      <style>{`.orc-chat-thread-title::before { content: attr(data-chat-title); }`}</style>
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
          {/* Compact fallback under sm, where the pill row is hidden. */}
          <select
            aria-label="Model"
            value={model}
            onChange={(e) => selectModel(e.target.value as ChatModel)}
            className="h-7 rounded-full border border-line-soft bg-bg-raise px-2 text-[12px] text-text sm:hidden"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="hidden max-w-full items-center gap-1 overflow-x-auto rounded-full border border-line-soft bg-bg-raise p-[2px] sm:flex">
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

      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen && (
          <SidebarPortal target={sharedSidebarTarget}>
            <aside className="flex h-full max-h-full w-[240px] min-h-0 flex-none flex-col border-r border-line-soft bg-bg-panel max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-20 max-sm:shadow-[0_8px_30px_rgba(8,9,11,0.75)]">
            <div className="flex items-center gap-1.5 p-2.5">
              <label className="relative flex min-w-0 flex-1 items-center">
                <Search size={13} className="pointer-events-none absolute left-2.5 text-text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chats"
                  className="h-8 w-full rounded-[8px] border border-line-soft bg-bg-raise pl-8 pr-2.5 text-[12px] text-text placeholder:text-text-faint outline-none focus:border-line"
                />
              </label>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close chat sidebar"
                title="Close sidebar"
                className="grid h-8 w-8 flex-none place-items-center rounded-[8px] text-text-faint hover:bg-bg-hover hover:text-text sm:hidden"
              >
                <PanelLeftClose size={14} />
              </button>
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
                          <article
                            key={t.id}
                            aria-label={`${t.title}${running ? ' (running)' : ''}`}
                            className={`group relative flex w-full flex-col gap-1 overflow-hidden rounded-[8px] border px-2.5 py-2 text-left transition-colors ${
                              running
                                ? 'border-line bg-bg-raise text-text'
                                : isActive
                                  ? 'border-line bg-bg-hover text-text'
                                  : 'border-transparent bg-transparent text-text hover:bg-bg-hover/60 hover:text-text'
                            }`}
                          >
                            {running && (
                              <span
                                aria-hidden="true"
                                className="orc-chat-border-shimmer pointer-events-none absolute inset-0 z-0 rounded-[8px]"
                              />
                            )}
                            <span className="relative z-10 flex flex-col gap-1 rounded-[6px]">
                              <span className="flex w-full items-center justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => setActiveThreadId(t.id)}
                                  aria-current={isActive}
                                  aria-label={t.title}
                                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded text-left text-[13px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
                                >
                                  <span className="grid h-5 w-5 flex-none place-items-center rounded-[6px] border border-line-soft bg-bg-raise text-text-faint">
                                    {running ? (
                                      <Loader2 size={11} className="animate-spin text-accent" />
                                    ) : (
                                      <MIcon size={11} />
                                    )}
                                  </span>
                                  <span
                                    className="orc-chat-thread-title truncate"
                                    data-chat-title={t.title}
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteThread(t.id)}
                                  className="grid h-5 w-5 flex-none place-items-center rounded text-text-faint opacity-0 hover:bg-bg-raise hover:text-text group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
                                  title="Delete chat"
                                  aria-label={`Delete chat ${t.title}`}
                                >
                                  <Trash2 size={11} />
                                </button>
                              </span>
                              <span className="line-clamp-1 text-[11px] text-text-faint">{preview}</span>
                            </span>
                          </article>
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
                Executes via <code className="font-mono text-accent">{commandFor(model, customCommand)}</code> with streaming output
              </span>
            </div>
            </aside>
          </SidebarPortal>
        )}

        <main className="flex min-h-0 flex-1 flex-col bg-bg">
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto"
            onScroll={(event) => {
              const element = event.currentTarget
              chatPinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
            }}
          >
            {!activeThread || activeThread.messages.length === 0 ? (
              <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-10">
                <div className="rounded-[12px] border border-line-soft bg-bg-panel p-5">
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold text-text">
                    <ModelIcon size={16} /> {MODELS.find((m) => m.id === model)?.label} Assistant
                  </h2>
                  <p className="mt-1.5 text-[13px] leading-[1.6] text-text-dim">
                    Direct integration with your installed agent CLI{' '}
                    <code className="rounded bg-bg-raise px-1.5 py-0.5 text-text font-mono">
                      {commandFor(model, customCommand)}
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
                    { k: 'Engine', v: commandFor(model, customCommand), sub: 'Headless CLI Process' },
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
                          return (
                            <span className="flex h-[13px] w-[13px] flex-none items-center justify-center">
                              <I size={13} />
                            </span>
                          )
                        })()}
                      </span>
                    )}
                    <div
                      className={`max-w-[78%] rounded-[12px] border px-3.5 py-3 ${
                        m.role === 'user'
                          ? 'border-line bg-bg-raise text-text'
                          : 'border-line-soft bg-bg-panel text-text'
                      }`}
                    >
                      {m.role === 'assistant' && m.content === '' && m.isStreaming ? (
                        <ThinkingIndicator command={commandFor(m.model || model, activeThread?.customCommand)} />
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
                              className="rounded px-1.5 py-0.5 text-[11px] text-text-faint opacity-0 transition-opacity hover:bg-bg-hover hover:text-text group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
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

          <div className="border-t border-line-soft bg-bg-panel p-3">
            <div className="mx-auto max-w-[760px]">
              {queued !== null && (
                <div role="status" className="mb-1.5 flex items-center justify-between gap-2 rounded-[8px] border border-line-soft bg-bg-raise px-2.5 py-1.5 text-[11px] text-text-dim">
                  <span className="truncate">Queued — sends when the current reply finishes</span>
                  <button type="button" onClick={() => setQueued(null)} className="flex-none text-text-faint hover:text-text">
                    Cancel
                  </button>
                </div>
              )}
              {promptError && (
                <div role="alert" className="mb-1.5 rounded-[8px] border border-red-900/50 bg-red-950/20 px-2.5 py-1.5 text-[11px] text-red-300">
                  {promptError}
                </div>
              )}
              <div className="rounded-[12px] border border-line bg-bg-panel shadow-[0_8px_30px_rgba(8,9,11,0.65)] focus-within:border-line">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value)
                    if (promptError) setPromptError(null)
                  }}
                  onPaste={onPaste}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                    if (e.key === 'Escape' && isGenerating) {
                      e.preventDefault()
                      stopCurrent()
                    }
                  }}
                  rows={1}
                  placeholder={
                    isGenerating
                      ? `Generating response from ${commandFor(model, customCommand)}… (keep typing — sends next)`
                      : `Message ${MODELS.find((m) => m.id === model)?.label} (${commandFor(model, customCommand)}) — Shift+Enter for new line`
                  }
                  aria-label="Chat message"
                  className="max-h-[140px] min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 text-[13px] text-text placeholder:text-text-faint outline-none"
                  style={{ height: 'auto' }}
                  onInput={(e) => {
                    const el = e.target as HTMLTextAreaElement
                    el.style.height = 'auto'
                    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
                  }}
                />
                <div className="flex items-center justify-between gap-2 border-t border-line-soft px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-1">
                    {model === 'custom' ? (
                      <input
                        value={customCommand}
                        onChange={(event) => updateCustomCommand(event.target.value)}
                        placeholder="CLI command, e.g. qwen -p {prompt}"
                        aria-label="Custom CLI command"
                        className="h-7 w-[min(360px,46vw)] rounded-[7px] border border-line-soft bg-bg-raise px-2 text-[11px] text-text outline-none focus:border-line"
                      />
                    ) : (
                      <ChatSelect
                        value={modelName}
                        onChange={updateModelName}
                        title="CLI model"
                        className="w-[min(220px,32vw)]"
                        options={modelSelectOptions.map((name) => ({
                          value: name,
                          label: modelCatalog[model]?.models.find((entry) => entry.id === name)?.label || name
                        }))}
                      />
                    )}
            {configuredEfforts.length > 0 && (
                      <ChatSelect
                        value={(effort ?? configuredEfforts[0]) as ChatEffort}
                        onChange={updateEffort}
                        title="Reasoning effort"
                        className="w-[96px]"
                        options={configuredEfforts.map((level) => ({
                          value: level,
                          label: level[0].toUpperCase() + level.slice(1)
                        }))}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isGenerating ? (
                      <button
                        onClick={stopCurrent}
                        className="flex items-center gap-1.5 rounded-[8px] bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-bg hover:opacity-80 transition-opacity"
                      >
                        <Square size={12} fill="currentColor" /> Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => void send()}
                        disabled={!input.trim() && !pendingImage}
                        className="flex items-center gap-1.5 rounded-[8px] bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-bg hover:opacity-90 disabled:opacity-40 transition-opacity"
                      >
                        <Send size={13} /> Send
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {(pendingImage || imageError) && (
                <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11px]">
                  <span className={imageError ? 'text-red-400' : 'text-text-faint'}>
                    {imageError || `Image attached: ${pendingImage?.name}`}
                  </span>
                  {pendingImage && (
                    <button type="button" className="text-text-faint hover:text-text" onClick={() => setPendingImage(null)}>
                      Remove
                    </button>
                  )}
                </div>
              )}
              <div className="mt-1.5 flex items-center justify-end px-1 text-[10px] text-text-faint">
                <span>Context {contextPercent}%</span>
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
