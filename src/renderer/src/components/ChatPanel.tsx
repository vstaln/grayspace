import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Key, X } from 'lucide-react'
import { pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { Markdown } from '../lib/markdown'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type { CatalogModel, RunState } from '../../../preload/index.d'

type Message = { role: 'user' | 'assistant'; text: string }
/**
 * `assistant` is not a chat backend at all — it is the built-in agent, which
 * plans and then acts on the canvas through the command bus. It sits in the
 * same picker because from the user's side the question is one question:
 * "who am I talking to?"
 */
type Provider = 'claude' | 'codex' | 'opencode' | 'openrouter' | 'assistant'
type Effort = 'low' | 'medium' | 'high'
type Mode = 'fast' | 'build' | 'plan'

interface ModelOption {
  /** Which backend runs it — a local CLI agent, or OpenRouter over the network. */
  provider: Provider
  id: string
  label: string
  group: string
  hint?: string
  /** Tokens the model can hold at once — drives the context-window ring. */
  contextLength: number
}

/**
 * The CLI agents installed on this machine. Their names — and context windows —
 * are fixed by the tools themselves, so unlike the OpenRouter catalog they are
 * not fetched; the numbers are each vendor's published window for the model.
 */
const ASSISTANT_MODEL: ModelOption = {
  provider: 'assistant',
  id: 'orcspace',
  label: 'Ассистент OrcSpace',
  group: 'Встроенный',
  hint: 'Выполняет цель шаг за шагом',
  contextLength: 200_000
}

const LOCAL_MODELS: ModelOption[] = [
  ASSISTANT_MODEL,
  { provider: 'claude', id: 'sonnet', label: 'Claude Sonnet', group: 'Локальные агенты', hint: 'Claude Code', contextLength: 200_000 },
  { provider: 'claude', id: 'opus', label: 'Claude Opus', group: 'Локальные агенты', hint: 'Claude Code', contextLength: 200_000 },
  { provider: 'codex', id: 'gpt-5-codex', label: 'GPT-5 Codex', group: 'Локальные агенты', hint: 'Codex', contextLength: 272_000 },
  { provider: 'codex', id: 'codex-mini-latest', label: 'Codex Mini', group: 'Локальные агенты', hint: 'Codex', contextLength: 200_000 },
  { provider: 'opencode', id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet', group: 'Локальные агенты', hint: 'OpenCode', contextLength: 200_000 },
  { provider: 'opencode', id: 'openai/gpt-5-codex', label: 'GPT-5 Codex', group: 'Локальные агенты', hint: 'OpenCode', contextLength: 272_000 }
]

/** ~4 characters per token — the usual rough estimate when a real tokenizer
 *  isn't available (the CLI agents don't report token counts back to us). */
const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

// One mode for now; the send path still speaks the full 'fast' | 'build' | 'plan'
// vocabulary, so adding the others back is a matter of listing them here.
const MODES: { id: Mode; label: string }[] = [{ id: 'fast', label: 'Fast' }]

export default function ChatPanel({
  open,
  onClose,
  /**
   * Bumped by the caller to mean "open on the assistant". A counter rather
   * than a boolean so asking for it twice in a row works — after the first
   * request the user may well have switched the engine back by hand.
   */
  focusAssistant = 0
}: {
  open: boolean
  onClose(): void
  focusAssistant?: number
}): React.JSX.Element | null {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [selected, setSelected] = useState<ModelOption>(LOCAL_MODELS[0])
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [effort, setEffort] = useState<Effort>('low')
  const [mode, setMode] = useState<Mode>('fast')
  const [busy, setBusy] = useState(false)
  // Some CLI agents (Claude Code, Codex) report their own token usage on
  // `done`; when they do, it is an exact figure and replaces the heuristic
  // below entirely instead of just tweaking it.
  const [realTokens, setRealTokens] = useState<number | null>(null)
  /** The live assistant run, when the assistant is the selected engine. */
  const [run, setRun] = useState<RunState | null>(null)
  const [hasKey, setHasKey] = useState(true) // assume yes until settings load, to avoid a flash of the prompt
  const [keyInput, setKeyInput] = useState('')
  const activeId = useRef<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  // Tab confinement + focus-in-on-open/restore-on-close while the panel is up
  // (P2-206).
  useFocusTrap(panelRef, open)

  useEffect(() => {
    void window.api.settings.get().then((s) => setHasKey(Boolean(s.openRouterApiKey)))
  }, [])

  // The catalog is fetched once the panel is first opened rather than at start-up:
  // a user who never opens the chat never pays for the request.
  useEffect(() => {
    if (!open || catalog.length > 0) return
    void window.api.chat.models().then(setCatalog)
    // Steps arrive as they happen, so the panel shows the run progressing
    // instead of sitting blank until it resolves.
    return window.api.assistant.onRun(setRun)
  }, [open, catalog.length])

  useEffect(
    () =>
      window.api.chat.onEvent((event) => {
        if (event.id !== activeId.current) return
        const delta = event.text
        if (event.type === 'delta' && delta)
          setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') last.text += delta
            else next.push({ role: 'assistant', text: delta })
            return next
          })
        if (event.type === 'error') {
          setMessages((p) => [...p, { role: 'assistant', text: `Ошибка: ${event.error}` }])
          setBusy(false)
        }
        if (event.type === 'done') {
          setBusy(false)
          if (event.tokens) setRealTokens(Number(event.tokens))
        }
      }),
    []
  )

  const modelOptions = useMemo<ModelOption[]>(
    () => [
      ...LOCAL_MODELS,
      ...catalog.map((m) => ({
        provider: 'openrouter' as const,
        id: m.id,
        label: m.label,
        group: 'OpenRouter',
        hint: m.free ? 'бесплатная' : undefined,
        // A handful of catalog entries omit it; 128k is OpenRouter's own floor.
        contextLength: m.contextLength || 128_000
      }))
    ],
    [catalog]
  )

  // Claude Code and Codex report real usage on `done` (see `realTokens`); that
  // figure already covers every message sent so far, so only the still-being-
  // typed input needs the character-count estimate on top of it. Providers
  // that don't report usage (OpenRouter, or before the first turn completes)
  // fall back to estimating the whole conversation.
  const usedTokens = useMemo(
    () =>
      realTokens !== null
        ? realTokens + estimateTokens(input)
        : messages.reduce((sum, m) => sum + estimateTokens(m.text), 0) + estimateTokens(input),
    [messages, input, realTokens]
  )
  const contextFraction = Math.min(1, usedTokens / selected.contextLength)

  if (!open) return null

  // The assistant plans through OpenRouter, so it needs the same key.
  const isAssistant = selected.provider === 'assistant'
  const needsKey = (selected.provider === 'openrouter' || isAssistant) && !hasKey

  const submit = async (): Promise<void> => {
    const prompt = input.trim()
    if (!prompt || busy) return

    // The assistant does not answer, it acts: the goal goes to the run engine,
    // and what comes back is a plan being executed rather than a reply.
    if (isAssistant) {
      setMessages((p) => [...p, { role: 'user', text: prompt }])
      setInput('')
      setBusy(true)
      const result = await window.api.assistant.start(prompt)
      setBusy(false)
      if (result && 'error' in result) {
        setMessages((p) => [...p, { role: 'assistant', text: `Ошибка: ${result.error}` }])
        return
      }
      setRun(result)
      return
    }

    const id = `chat-${Date.now()}`
    activeId.current = id
    setMessages((p) => [...p, { role: 'user', text: prompt }])
    setInput('')
    setBusy(true)
    const result = await window.api.chat.send({
      id,
      // Narrowed by the early return above: the assistant never reaches here,
      // and `chat.send` only knows the four real chat backends.
      provider: selected.provider as Exclude<Provider, 'assistant'>,
      prompt,
      model: selected.id,
      effort,
      mode
    })
    if (!result.ok) {
      setMessages((p) => [...p, { role: 'assistant', text: `Ошибка: ${result.error}` }])
      setBusy(false)
    }
  }

  const stop = (): void => {
    if (activeId.current) window.api.chat.cancel(activeId.current)
    setBusy(false)
  }

  const saveKey = async (): Promise<void> => {
    const key = keyInput.trim()
    if (!key) return
    await window.api.settings.set({ openRouterApiKey: key })
    setKeyInput('')
    setHasKey(true)
  }

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Чат агента"
      className="chat-panel-shell fixed top-0 right-0 bottom-0 z-[800] flex w-[380px] flex-col overflow-hidden border-l border-line-soft"
    >
      <header className="flex flex-none items-center justify-between border-b border-line-soft px-4 py-3.5 pr-28">
        <div className="min-w-0">
          <b className="block truncate text-[13px] text-text">{selected.label}</b>
          <span className="text-[10px] text-text-faint">
            {selected.provider === 'openrouter' ? 'OpenRouter' : selected.hint || 'локальный агент'}
          </span>
        </div>
        <div className="flex flex-none items-center gap-1">
          {!needsKey && <ContextRing fraction={contextFraction} usedTokens={usedTokens} contextLength={selected.contextLength} />}
          <button
            className="flex-none rounded-[10px] border-0 bg-transparent p-1 text-text-faint transition-colors hover:text-text"
            onClick={onClose}
            aria-label="Закрыть чат"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      {needsKey ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Key size={22} className="text-text-faint" />
          <p className="text-xs text-text-dim">
            Нужен бесплатный ключ OpenRouter — получите его на openrouter.ai и вставьте сюда.
          </p>
          <input
            className="w-full rounded-[10px] border border-line bg-bg-raise p-2 text-xs text-text outline-none transition-colors focus:border-text-faint"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="sk-or-v1-…"
            type="password"
            onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
          />
          <button
            className="w-full rounded-[10px] bg-accent py-2 text-xs font-semibold text-bg disabled:opacity-35"
            disabled={!keyInput.trim()}
            onClick={() => void saveKey()}
          >
            Сохранить ключ
          </button>
          <button className="text-[11px] text-text-dim hover:text-text" onClick={() => setSelected(LOCAL_MODELS[0])}>
            Использовать локальный агент вместо этого
          </button>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" role="log" aria-live="polite">
            {messages.length === 0 && (
              <p className="m-auto max-w-[80%] text-center text-[13px] leading-relaxed text-text-faint">
                {isAssistant
                  ? 'Опишите цель — ассистент составит план и выполнит его на холсте. Он берёт блокировки как обычный участник, обходит занятые ресурсы и спрашивает перед всем, что удаляет.'
                  : `Спросите ${selected.label} о проекте, задаче или следующем действии.`}
              </p>
            )}
            {messages.map((m, i) => (
              <MessageView key={i} message={m} />
            ))}
            {isAssistant && run && (
              <RunView
                run={run}
                onAnswer={(approved) => {
                  setBusy(true)
                  void window.api.assistant.answer(run.runId, approved).then((next) => {
                    setBusy(false)
                    if (next) setRun(next)
                  })
                }}
              />
            )}
            {busy && (
              <div className="flex items-center gap-1.5 rounded-[10px] p-1.5 text-[11px] text-text-dim" role="status">
                <i className="thinking-dot h-1.5 w-1.5 rounded-full bg-text-dim" />
                <i className="thinking-dot h-1.5 w-1.5 rounded-full bg-text-dim" />
                <i className="thinking-dot h-1.5 w-1.5 rounded-full bg-text-dim" />
                <span>думает</span>
              </div>
            )}
          </div>

          {/* Input and controls share one card, the way the reference composer
              reads as a single object rather than a field with a toolbar. */}
          <div className="flex-none p-2.5">
            <form
              className="composer-shell rounded-[10px] border border-line transition-colors focus-within:border-text-faint"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <div className="flex items-start gap-2 px-3 pt-2.5">
                <textarea
                  className="max-h-[132px] min-h-[38px] flex-1 resize-none border-0 bg-transparent text-[13.5px] text-text outline-none placeholder:text-text-faint"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Напишите сообщение…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                  onPaste={(e) => {
                    // The CLI agents read images off disk, so a pasted picture becomes a
                    // path in the prompt rather than an inline attachment.
                    if (!pasteHasImage(e.nativeEvent)) return
                    e.preventDefault()
                    void saveImageFromPaste(e.nativeEvent).then((saved) => {
                      if (saved) setInput((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}"${saved.path}" `)
                    })
                  }}
                />
                {busy ? (
                  <button
                    className="grid h-8 w-8 flex-none place-items-center rounded-full border border-danger/30 bg-danger/12 text-danger transition-colors hover:bg-danger/20"
                    onClick={stop}
                    type="button"
                    title="Остановить ответ"
                    aria-label="Остановить ответ"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <button
                    className="grid h-8 w-8 flex-none place-items-center rounded-full border border-line bg-bg-hover text-text-dim transition-colors hover:border-text-faint hover:text-text disabled:opacity-40 disabled:hover:border-line disabled:hover:text-text-dim"
                    disabled={!input.trim() || busy}
                    type="submit"
                    aria-label="Отправить"
                  >
                    <ArrowUp size={15} />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-0.5 px-2 pt-1 pb-1.5">
              <Picker
                className="min-w-0 flex-1"
                label="Модель"
                value={selected.label}
                align="left"
                searchable
                options={modelOptions.map((m) => ({
                  id: `${m.provider}:${m.id}`,
                  label: m.label,
                  hint: m.hint,
                  group: m.group
                }))}
                selectedId={`${selected.provider}:${selected.id}`}
                onSelect={(id) => {
                  const next = modelOptions.find((m) => `${m.provider}:${m.id}` === id)
                  if (next) setSelected(next)
                }}
                onRefresh={() => void window.api.chat.models(true).then(setCatalog)}
              />
              <Picker
                className="flex-none"
                label="Усилие"
                value={EFFORTS.find((e) => e.id === effort)?.label ?? effort}
                options={EFFORTS.map((e) => ({ id: e.id, label: e.label }))}
                selectedId={effort}
                onSelect={(id) => setEffort(id as Effort)}
              />
              <Picker
                className="flex-none"
                label="Режим"
                value={MODES.find((m) => m.id === mode)?.label ?? mode}
                options={MODES.map((m) => ({ id: m.id, label: m.label }))}
                selectedId={mode}
                onSelect={(id) => setMode(id as Mode)}
              />
              </div>
            </form>
          </div>
        </>
      )}
    </aside>
  )
}

interface PickerItem {
  id: string
  label: string
  hint?: string
  group?: string
}

/**
 * Text-only dropdown for the composer bar. A native `<select>` cannot show the
 * group headers, secondary hints or the search box the model list needs once it
 * holds the whole OpenRouter catalog, so this is a plain button + popup.
 */
function Picker({
  label,
  value,
  options,
  selectedId,
  onSelect,
  onRefresh,
  searchable,
  className,
  align = 'right'
}: {
  label: string
  value: string
  options: PickerItem[]
  selectedId: string
  onSelect(id: string): void
  onRefresh?(): void
  searchable?: boolean
  className?: string
  /** Which edge the popup hangs from. The panel clips overflow, so a wide popup
   *  on a left-hand trigger must open rightwards or its text is cut off. */
  align?: 'left' | 'right'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => `${o.label} ${o.id} ${o.hint ?? ''}`.toLowerCase().includes(q))
  }, [options, query])

  // Group headers are only worth drawing when the list actually spans groups.
  const grouped = useMemo(() => {
    const out: { group?: string; items: PickerItem[] }[] = []
    for (const item of filtered) {
      const last = out[out.length - 1]
      if (last && last.group === item.group) last.items.push(item)
      else out.push({ group: item.group, items: [item] })
    }
    return out
  }, [filtered])

  return (
    <div className={`relative ${className ?? ''}`} ref={rootRef}>
      {/* Borderless: the composer card already frames these, so a box round each
          one would read as three nested fields instead of one bar. */}
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-[10px] px-1.5 py-1 text-[11px] transition-colors hover:bg-bg-hover ${
          open ? 'bg-bg-hover' : ''
        }`}
        onClick={() => {
          setOpen((v) => !v)
          setQuery('')
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${value}`}
        title={`${label}: ${value}`}
      >
        <span className="min-w-0 flex-1 truncate text-left text-text-dim">{value}</span>
        <span className="flex-none text-[9px] text-text-faint">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={label}
          className={`absolute bottom-[calc(100%+6px)] z-[900] max-h-72 w-[248px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[10px] border border-line bg-bg-panel shadow-2xl glass:bg-bg-panel/90 glass:backdrop-blur-2xl ${
            align === 'left' ? 'left-0' : 'right-0'
          }`}
        >
          {searchable && (
            <div className="flex items-center gap-1.5 border-b border-line-soft p-1.5">
              <input
                autoFocus
                className="min-w-0 flex-1 rounded-[10px] border border-line-soft bg-bg-raise px-2 py-1.5 text-[11px] text-text outline-none transition-colors placeholder:text-text-faint focus:border-text-faint"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск модели…"
              />
              {onRefresh && (
                <button
                  type="button"
                  className="flex-none rounded-[10px] border border-line-soft px-2 py-1.5 text-[10px] text-text-faint transition-colors hover:border-line hover:text-text"
                  onClick={onRefresh}
                  title="Обновить список из OpenRouter"
                >
                  Обновить
                </button>
              )}
            </div>
          )}

          <div className="max-h-56 overflow-auto p-1">
            {grouped.map((section, i) => (
              <div key={section.group ?? i}>
                {section.group && (
                  <div className="px-2 pt-2 pb-1 text-[9px] tracking-wider text-text-faint uppercase">
                    {section.group}
                  </div>
                )}
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === selectedId}
                    className={`flex w-full items-baseline gap-2 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-bg-hover ${
                      item.id === selectedId ? 'bg-bg-hover' : ''
                    }`}
                    onClick={() => {
                      onSelect(item.id)
                      setOpen(false)
                    }}
                  >
                    <span
                      className={`min-w-0 flex-1 truncate text-[11.5px] ${
                        item.id === selectedId ? 'text-accent' : 'text-text'
                      }`}
                    >
                      {item.label}
                    </span>
                    {item.hint && <span className="flex-none text-[9.5px] text-text-faint">{item.hint}</span>}
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-4 text-center text-[11px] text-text-faint">Ничего не найдено</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const RING_RADIUS = 8
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * Small ring showing roughly how much of the model's context window this
 * conversation has used — an estimate (see `estimateTokens`), not a figure the
 * provider reported, so the tooltip says so rather than implying precision.
 */
function ContextRing({
  fraction,
  usedTokens,
  contextLength
}: {
  fraction: number
  usedTokens: number
  contextLength: number
}): React.JSX.Element {
  const dash = fraction * RING_CIRCUMFERENCE
  // Neutral until it matters, then amber, then red — the same escalation the
  // rest of the app uses for "getting close to a limit".
  const color = fraction > 0.9 ? 'var(--color-danger)' : fraction > 0.7 ? '#e9b828' : 'var(--color-text-faint)'
  const percent = Math.round(fraction * 100)

  return (
    <div
      className="grid h-6 w-6 flex-none place-items-center"
      title={`≈${percent}% контекста занято (примерно ${usedTokens.toLocaleString('ru')} из ${contextLength.toLocaleString('ru')} токенов)`}
    >
      <svg width={20} height={20} viewBox="0 0 20 20" className="-rotate-90">
        <circle cx={10} cy={10} r={RING_RADIUS} fill="none" stroke="var(--color-line)" strokeWidth={2} />
        <circle
          cx={10}
          cy={10}
          r={RING_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
          style={{ transition: 'stroke-dasharray 0.2s ease, stroke 0.2s ease' }}
        />
      </svg>
    </div>
  )
}

/** One chat bubble. Memoized (PERF-008): while the agent streams, only the
 *  last message's text changes, so the earlier history must not re-render —
 *  the `text` prop identity keeps completed bubbles stable. */
/**
 * A run in progress: the plan with the current step marked, the trace under
 * it, and — when the graph has stopped at the human gate — the two buttons
 * that are the whole reason the gate can exist.
 */
function RunView({ run, onAnswer }: { run: RunState; onAnswer(approved: boolean): void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line-soft bg-white/[0.02] p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-[11px] text-text-dim">{run.goal}</span>
        <RunStatus status={run.status} />
      </div>

      {run.plan.length > 0 && (
        <ol className="flex flex-col gap-1">
          {run.plan.map((step, i) => (
            <li
              key={`${step.command}-${i}`}
              className={`flex items-start gap-1.5 text-[11px] ${
                i < run.cursor ? 'text-text-faint line-through' : i === run.cursor ? 'text-text' : 'text-text-dim'
              }`}
            >
              <span className="flex-none text-text-faint">{i + 1}.</span>
              <span className="min-w-0 flex-1">{step.summary}</span>
            </li>
          ))}
        </ol>
      )}

      {run.log.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-line-soft pt-1.5">
          {run.log.slice(-6).map((line, i) => (
            <p key={i} className="text-[10.5px] leading-relaxed text-text-faint">
              {line}
            </p>
          ))}
        </div>
      )}

      {run.error && <p className="text-[11px] text-danger">{run.error}</p>}

      {run.status === 'waiting_human' && (
        <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2">
          <p className="text-[11px] text-text">{run.question}</p>
          <div className="flex gap-1.5">
            <button
              className="flex-1 rounded-[10px] bg-accent px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-white"
              onClick={() => onAnswer(true)}
            >
              Разрешить
            </button>
            <button
              className="flex-1 rounded-[10px] border border-line px-2.5 py-1 text-[11px] text-text hover:bg-bg-hover"
              onClick={() => onAnswer(false)}
            >
              Отклонить
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function RunStatus({ status }: { status: RunState['status'] }): React.JSX.Element {
  const label = { running: 'работает', waiting_human: 'ждёт вас', done: 'готово', failed: 'ошибка' }[status]
  const tone = {
    running: 'border-line text-text-dim',
    waiting_human: 'border-[#f59e0b]/40 text-[#f59e0b]',
    done: 'border-ok/40 text-ok',
    failed: 'border-danger/40 text-danger'
  }[status]
  return <span className={`flex-none rounded-full border px-1.5 py-0.5 text-[9.5px] ${tone}`}>{label}</span>
}

const MessageView = React.memo(function MessageView({ message }: { message: Message }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="max-w-[85%] self-end rounded-[10px] border border-line-soft bg-bg-panel px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-text">
        {message.text}
      </div>
    )
  }
  return (
    <div className="w-full text-[13.5px] leading-relaxed text-text-dim">
      <Markdown text={message.text} />
    </div>
  )
})
