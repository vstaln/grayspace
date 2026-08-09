import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Check, FilePlus2, Folder, Link2, List, Loader, Network, Search, Tag, Trash2, X } from 'lucide-react'
import BrainGraph from './BrainGraph'
import NoteAttachments from './NoteAttachments'
import { insertAt, pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { useSettings } from '../hooks/useSettings'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useConfirm } from './ConfirmDialog'
import type { BrainGraph as GraphData, BrainNote, LinkSyntax } from '../../../preload/index.d'

interface Props {
  workspaceDir: string | null
  /** Which pane opens first — the rail's graph button jumps straight to 'graph'. */
  initialView?: 'list' | 'graph'
  onViewChange?(view: 'list' | 'graph'): void
  onClose(): void
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

/** Human-readable form of the active link syntax, shown in the header. */
function syntaxHint(syntax: LinkSyntax): React.ReactNode {
  if (syntax === 'dollar') return <>Связи: <code>$Название заметки</code></>
  if (syntax === 'wiki') return <>Связи: <code>[[Название заметки]]</code></>
  return <>Связи: <code>[[Название]]</code> или <code>$Название</code></>
}

export default function SecondBrain({ workspaceDir, initialView = 'list', onViewChange, onClose }: Props): React.JSX.Element {
  const { settings } = useSettings()
  const confirm = useConfirm()
  const [notes, setNotes] = useState<BrainNote[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'list' | 'graph'>(initialView)

  // The rail can flip the pane while the panel is already open.
  useEffect(() => setView(initialView), [initialView])
  // Keep the rail's graph button lit in sync with the pane actually shown.
  useEffect(() => onViewChange?.(view), [view, onViewChange])
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] })
  const [save, setSave] = useState<SaveState>('saved')
  const [trash, setTrash] = useState<BrainNote[]>([])
  const [showTrash, setShowTrash] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  // The panel mounts only while open; the trap's cleanup restores focus to the
  // element that was focused before it opened (P2-206).
  useFocusTrap(panelRef, true)

  const note = notes.find((n) => n.id === selected) || null

  const reload = useCallback(async (): Promise<BrainNote[]> => {
    const { notes: next } = await window.api.brain.list()
    setNotes(next)
    setGraph(await window.api.brain.graph())
    setTrash(await window.api.brain.trash())
    return next
  }, [])

  useEffect(() => {
    void reload().then((next) => setSelected((current) => current ?? next[0]?.id ?? null))
  }, [reload])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes.filter((n) => !q || `${n.title} ${n.content} ${n.tags.join(' ')}`.toLowerCase().includes(q))
  }, [notes, query])

  /** Folder → notes, folder-less notes last under a synthetic "" bucket. */
  const grouped = useMemo(() => {
    const byFolder = new Map<string, BrainNote[]>()
    for (const n of visible) {
      const key = n.folder || ''
      byFolder.set(key, [...(byFolder.get(key) || []), n])
    }
    return Array.from(byFolder.entries()).sort(([a], [b]) => {
      if (!a) return 1
      if (!b) return -1
      return a.localeCompare(b)
    })
  }, [visible])
  const allFolders = useMemo(
    () => Array.from(new Set(notes.map((n) => n.folder).filter((f): f is string => Boolean(f)))).sort((a, b) => a.localeCompare(b)),
    [notes]
  )

  /** Notes pointing at the open one — the incoming half of each link. */
  const backlinks = useMemo(() => (note ? notes.filter((n) => (n.links || []).includes(note.id)) : []), [notes, note])
  const outgoing = useMemo(
    () => (note?.links || []).map((id) => notes.find((n) => n.id === id)).filter((n): n is BrainNote => Boolean(n)),
    [notes, note]
  )

  const create = async (title = 'Новая заметка', content = ''): Promise<void> => {
    const created = await window.api.brain.create({
      title,
      content,
      tags: [],
      projectDir: workspaceDir || undefined
    })
    await reload()
    setSelected(created.id)
    setView('list')
  }

  const remove = async (): Promise<void> => {
    if (!note) return
    const ok = await confirm(
      `Переместить заметку «${note.title}» в корзину? Она исчезнет из списка и графа, но её можно восстановить в течение 30 дней.`,
      { danger: true, confirmLabel: 'В корзину' }
    )
    if (!ok) return
    await window.api.brain.delete(note.id)
    const next = await reload()
    setSelected(next.find((n) => n.id !== note.id)?.id ?? null)
  }

  const restoreNote = async (id: string): Promise<void> => {
    await window.api.brain.restore(id)
    await reload()
  }

  const purgeNote = async (id: string, title: string): Promise<void> => {
    const ok = await confirm(`Удалить заметку «${title}» навсегда? Это действие необратимо.`, {
      danger: true,
      confirmLabel: 'Удалить навсегда'
    })
    if (!ok) return
    await window.api.brain.purge(id)
    await reload()
  }

  /** Optimistic local edit; the debounced writer below persists it. */
  const patch = (changes: Partial<BrainNote>): void => {
    if (!note) return
    setNotes((list) => list.map((n) => (n.id === note.id ? { ...n, ...changes } : n)))
    setSave('dirty')
  }

  // Coalesce keystrokes into one write so typing never blocks on disk I/O.
  const pending = useRef<BrainNote | null>(null)
  pending.current = note
  useEffect(() => {
    if (save !== 'dirty' || !pending.current) return
    const snapshot = pending.current
    const timer = setTimeout(async () => {
      setSave('saving')
      try {
        await window.api.brain.update(snapshot.id, {
          title: snapshot.title,
          content: snapshot.content,
          tags: snapshot.tags,
          folder: snapshot.folder,
          color: snapshot.color
        })
        setGraph(await window.api.brain.graph())
        const { notes: fresh } = await window.api.brain.list()
        // Keep server-derived fields (links, unresolved) without clobbering typing.
        setNotes((list) =>
          list.map((n) => {
            const server = fresh.find((f) => f.id === n.id)
            return server ? { ...n, links: server.links, unresolved: server.unresolved, updatedAt: server.updatedAt } : n
          })
        )
        setSave((current) => (current === 'saving' ? 'saved' : current))
      } catch {
        // The editor keeps the typed text; the next keystroke retries (P2-218).
        setSave('error')
      }
    }, 450)
    return () => clearTimeout(timer)
  }, [save, note?.title, note?.content, note?.tags, note?.folder, note?.color])

  // Closing the panel or flipping to the graph while a keystroke is still
  // pending must not drop the last edit — flush it on unmount (DI-003).
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = save === 'dirty'
  }, [save])
  useEffect(() => {
    return () => {
      const pendingNote = pending.current
      if (dirtyRef.current && pendingNote) {
        void window.api.brain.update(pendingNote.id, {
          title: pendingNote.title,
          content: pendingNote.content,
          tags: pendingNote.tags,
          folder: pendingNote.folder,
          color: pendingNote.color
        })
      }
    }
  }, [])

  // Escape closes the panel — matches ChatPanel/KanbanBoard's expectation that
  // a full-screen modal responds to the same key the user reaches for first.
  // From the full-screen graph the first Escape steps back to the list rather
  // than closing outright — the graph is a mode inside the panel, and losing
  // the whole panel because you wanted out of the map is a surprise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (view === 'graph') setView('list')
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, view])

  /** Opens a note by title, creating it when the link is still unresolved. */
  const openByTitle = async (title: string): Promise<void> => {
    const existing = notes.find((n) => n.title.toLowerCase() === title.trim().toLowerCase())
    if (existing) {
      setSelected(existing.id)
      setView('list')
      return
    }
    await create(title.trim())
  }

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Второй мозг"
      /* The graph takes the whole screen: it is a map, and a map framed inside
         a panel with a header is a map you cannot read. Other views keep the
         inset panel. */
      className={
        view === 'graph'
          ? 'brain-panel-shell fixed inset-0 z-[650] flex flex-col overflow-hidden bg-black'
          : 'brain-panel-shell fixed inset-[52px_24px_24px_80px] z-[650] flex flex-col overflow-hidden rounded-[10px] border border-line shadow-[0_30px_90px_rgba(0,0,0,0.75)] glass:border-line-soft glass:bg-bg-panel/72 glass:backdrop-blur-2xl glass:backdrop-saturate-150'
      }
    >
      <header
        className={`flex flex-none items-center justify-between gap-4 border-b border-line-soft bg-bg-raise px-4 py-3.5 glass:bg-transparent ${view === 'graph' ? 'hidden' : ''}`}
      >
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <Brain size={17} className="text-text-dim" /> Второй мозг
          </h2>
          <p className="mt-1 text-[11px] text-text-faint">
            {syntaxHint(settings.linkSyntax)} · синтаксис меняется в настройках
          </p>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <button
            className="flex items-center gap-1.5 rounded-[10px] border border-line bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-text hover:bg-bg-hover"
            onClick={() => setView((v) => (v === 'graph' ? 'list' : 'graph'))}
          >
            {view === 'graph' ? (
              <>
                <List size={14} /> Список
              </>
            ) : (
              <>
                <Network size={14} /> Граф
              </>
            )}
          </button>
          <button
            className="flex items-center gap-1.5 rounded-[10px] bg-accent px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-white"
            onClick={() => void create()}
          >
            <FilePlus2 size={14} /> Заметка
          </button>
          <button
            className="grid h-8 w-8 place-items-center rounded-[10px] border border-line bg-white/[0.03] text-text hover:bg-bg-hover"
            title="Закрыть"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {view === 'graph' ? (
        <BrainGraph
          graph={graph}
          selectedId={selected}
          onOpen={(id) => {
            setSelected(id)
            setView('list')
          }}
          fullscreen
          onExit={() => setView('list')}
        />
      ) : (
        <div
          className={`grid min-h-0 flex-1 ${note ? 'grid-cols-[290px_minmax(0,1fr)_236px]' : 'grid-cols-[290px_minmax(0,1fr)]'} max-lg:grid-cols-[240px_minmax(0,1fr)]`}
        >
          <aside className="flex flex-col gap-1.5 overflow-auto border-r border-line-soft p-2.5">
            <label className="flex flex-none items-center gap-1.5 rounded-[10px] border border-line bg-bg px-2.5 text-text-faint focus-within:border-text-faint">
              <Search size={14} />
              <input
                className="w-full border-0 bg-transparent py-2 text-xs text-text outline-none"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по памяти…"
              />
            </label>
            {grouped.map(([folder, items]) => (
              <React.Fragment key={folder || '__none__'}>
                {grouped.length > 1 && (
                  <div className="mt-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wide text-text-faint uppercase first:mt-0">
                    <Folder size={11} />
                    {folder || 'Без папки'}
                  </div>
                )}
                {items.map((n) => (
                  <button
                    key={n.id}
                    className={`block w-full rounded-[10px] border border-transparent p-2.5 text-left text-text hover:bg-bg-hover ${
                      selected === n.id ? 'border-line bg-bg-hover' : ''
                    }`}
                    onClick={() => setSelected(n.id)}
                  >
                    <b className="flex items-center gap-1.5 truncate text-[13px] font-semibold">
                      {n.color && <span className="h-2 w-2 flex-none rounded-full" style={{ background: n.color }} />}
                      <span className="truncate">{n.title || 'Без названия'}</span>
                    </b>
                    <span className="mt-1 block truncate text-[11px] text-text-faint">{n.content.slice(0, 90) || 'Пустая заметка'}</span>
                    {(n.tags.length > 0 || (n.links || []).length > 0) && (
                      <small className="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-dim">
                        {n.tags.length > 0 && (
                          <span className="flex items-center gap-1">
                            <Tag size={11} />
                            {n.tags.join(' · ')}
                          </span>
                        )}
                        {(n.links || []).length > 0 && (
                          <span className="flex items-center gap-1">
                            <Link2 size={11} />
                            {n.links?.length}
                          </span>
                        )}
                      </small>
                    )}
                  </button>
                ))}
              </React.Fragment>
            ))}
            {!visible.length && (
              <div className="m-auto text-center text-xs text-text-faint">{query ? 'Ничего не найдено' : 'Пока нет заметок'}</div>
            )}

            {trash.length > 0 && (
              <>
                <div className="my-1 border-t border-line-soft" />
                <button
                  className="flex w-full items-center justify-between rounded-[10px] px-2 py-1.5 text-left text-[11px] font-semibold tracking-wide text-text-faint uppercase hover:bg-bg-hover hover:text-text"
                  onClick={() => setShowTrash((v) => !v)}
                >
                  <span className="flex items-center gap-1.5">
                    <Trash2 size={12} />
                    Корзина ({trash.length})
                  </span>
                  <span className="text-text-faint">{showTrash ? '−' : '+'}</span>
                </button>
                {showTrash &&
                  trash.map((n) => (
                    <div key={n.id} className="flex w-full items-center gap-1 rounded-[10px] border border-dashed border-line-soft p-1.5">
                      <span className="block min-w-0 flex-1 truncate text-[11px] text-text-faint">{n.title || 'Без названия'}</span>
                      <button
                        className="flex-none rounded-[10px] border border-line px-1.5 py-0.5 text-[10px] text-text hover:bg-bg-hover"
                        title="Восстановить"
                        onClick={() => void restoreNote(n.id)}
                      >
                        Вернуть
                      </button>
                      <button
                        className="flex-none rounded-[10px] border border-danger/40 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/15"
                        title="Удалить навсегда"
                        onClick={() => void purgeNote(n.id, n.title)}
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
              </>
            )}
          </aside>

          {note ? (
            <>
              <NoteEditor
                key={note.id}
                note={note}
                notes={notes}
                folders={allFolders}
                syntax={settings.linkSyntax}
                save={save}
                onPatch={patch}
                onDelete={() => void remove()}
              />
              <aside className="flex flex-col gap-4 overflow-auto border-l border-line-soft p-3.5 max-lg:hidden">
                <LinkGroup title="Ссылается на" notes={outgoing} onOpen={setSelected} />
                <LinkGroup title="Обратные связи" notes={backlinks} onOpen={setSelected} />
                {(note.unresolved || []).length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <h4 className="text-[11px] font-semibold tracking-wide text-text-faint uppercase">Ещё не созданы</h4>
                    {note.unresolved?.map((title) => (
                      <button
                        key={title}
                        className="rounded-[10px] border border-dashed border-line-soft px-2.5 py-1.5 text-left text-xs text-text-faint hover:border-line hover:text-text"
                        onClick={() => void openByTitle(title)}
                      >
                        + {title}
                      </button>
                    ))}
                  </div>
                )}
              </aside>
            </>
          ) : (
            <div className="m-auto text-center text-xs text-text-faint">Выберите или создайте заметку</div>
          )}
        </div>
      )}
    </section>
  )
}

function LinkGroup({ title, notes, onOpen }: { title: string; notes: BrainNote[]; onOpen(id: string): void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-text-faint uppercase">
        {title} <i className="not-italic text-text-dim">{notes.length}</i>
      </h4>
      {notes.map((n) => (
        <button
          key={n.id}
          className="truncate rounded-[10px] border border-line-soft px-2.5 py-1.5 text-left text-xs text-text hover:bg-bg-hover"
          onClick={() => onOpen(n.id)}
        >
          {n.title}
        </button>
      ))}
      {!notes.length && <p className="text-[11px] text-text-faint">пусто</p>}
    </div>
  )
}

/** The editor itself: title, body with link autocomplete, tags, save status. */
/** Small, tasteful accent palette — matches the swatches used on the graph. */
const NOTE_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6']

function NoteEditor({
  note,
  notes,
  folders,
  syntax,
  save,
  onPatch,
  onDelete
}: {
  note: BrainNote
  notes: BrainNote[]
  folders: string[]
  syntax: LinkSyntax
  save: SaveState
  onPatch(changes: Partial<BrainNote>): void
  onDelete(): void
}): React.JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [suggest, setSuggest] = useState<{ token: string; start: number; items: BrainNote[]; index: number } | null>(null)

  /** Finds a half-typed link immediately before the caret. */
  const scanToken = (value: string, caret: number): { token: string; start: number } | null => {
    const before = value.slice(0, caret)
    if (syntax !== 'dollar') {
      const open = before.lastIndexOf('[[')
      if (open >= 0 && !before.slice(open).includes(']]') && !before.slice(open).includes('\n'))
        return { token: before.slice(open + 2), start: open }
    }
    if (syntax !== 'wiki') {
      const match = /(^|\s)\$([^\s$]*)$/.exec(before)
      if (match) return { token: match[2], start: caret - match[2].length - 1 }
    }
    return null
  }

  const refreshSuggest = (value: string, caret: number): void => {
    const found = scanToken(value, caret)
    if (!found) return setSuggest(null)
    const q = found.token.trim().toLowerCase()
    const items = notes.filter((n) => n.id !== note.id && n.title.toLowerCase().includes(q)).slice(0, 6)
    setSuggest(items.length ? { ...found, items, index: 0 } : null)
  }

  /** Replaces the half-typed token with a complete link to `target`. */
  const accept = (target: BrainNote): void => {
    const area = areaRef.current
    if (!area || !suggest) return
    const caret = area.selectionStart
    const insert = syntax === 'dollar' ? `$${target.title}` : `[[${target.title}]]`
    const next = note.content.slice(0, suggest.start) + insert + note.content.slice(caret)
    onPatch({ content: next })
    setSuggest(null)
    // Put the caret after the inserted link once React has re-rendered.
    requestAnimationFrame(() => {
      area.focus()
      const at = suggest.start + insert.length
      area.setSelectionRange(at, at)
    })
  }

  /** Mirrors NoteWidget: pictures land on disk and are linked from the body. */
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (!pasteHasImage(e.nativeEvent)) return
    e.preventDefault()
    const area = e.currentTarget
    const { selectionStart, selectionEnd, value } = area
    const saved = await saveImageFromPaste(e.nativeEvent)
    if (!saved) return
    const { value: next, caret } = insertAt(
      value,
      selectionStart,
      selectionEnd,
      `\n![${saved.name}](${saved.path})\n`
    )
    onPatch({ content: next })
    requestAnimationFrame(() => area.setSelectionRange(caret, caret))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!suggest) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setSuggest((s) => (s ? { ...s, index: (s.index + delta + s.items.length) % s.items.length } : s))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      accept(suggest.items[suggest.index])
    } else if (e.key === 'Escape') {
      // Otherwise this bubbles up to the panel's own Escape handler and
      // closes the whole editor when the user only meant to dismiss the
      // link-suggestion popup.
      e.stopPropagation()
      setSuggest(null)
    }
  }

  return (
    <article className="flex min-w-0 flex-col gap-3 px-6 pt-[22px] pb-[18px]">
      <div className="flex items-center justify-between gap-3">
        <input
          className="w-full border-0 bg-transparent text-[23px] font-bold text-text outline-none"
          value={note.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder="Название"
        />
        <span className="flex flex-none items-center gap-1.5 text-[11px] text-text-faint" role="status" aria-live="polite">
          {save === 'saved' && (
            <>
              <Check size={13} /> сохранено
            </>
          )}
          {save === 'saving' && (
            <>
              <Loader size={13} className="animate-spin" /> сохраняю…
            </>
          )}
          {save === 'dirty' && <>есть изменения</>}
          {save === 'error' && <>ошибка сохранения — правка останется при следующем вводе</>}
        </span>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-text-faint">
        <span>{note.projectDir ? `Проект: ${note.projectDir.split(/[\\/]/).pop()}` : 'Общая заметка'}</span>
        <span>· изменено {new Date(note.updatedAt).toLocaleString()}</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <textarea
          ref={areaRef}
          className="h-full w-full resize-none rounded-[10px] border border-line bg-bg p-3.5 text-sm leading-relaxed text-text outline-none focus:border-text-faint"
          value={note.content}
          onChange={(e) => {
            onPatch({ content: e.target.value })
            refreshSuggest(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
          onBlur={() => setTimeout(() => setSuggest(null), 120)}
          placeholder={
            syntax === 'dollar'
              ? 'Пишите свободно. Связь с заметкой: $Название заметки'
              : 'Пишите свободно. Связь с заметкой: [[Название заметки]]'
          }
        />
        {suggest && (
          <div className="absolute bottom-2.5 left-2.5 z-10 max-h-52 w-64 overflow-auto rounded-[10px] border border-line bg-bg-panel p-1 shadow-2xl glass:bg-bg-panel/90 glass:backdrop-blur-xl">
            {suggest.items.map((item, i) => (
              <button
                key={item.id}
                className={`flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-left text-xs ${
                  i === suggest.index ? 'bg-bg-hover text-text' : 'text-text-dim'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(item)
                }}
              >
                <Link2 size={12} /> {item.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <NoteAttachments content={note.content} />

      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-1.5 rounded-[10px] border border-line bg-bg px-2.5 text-text-faint focus-within:border-text-faint">
          <Tag size={14} />
          <input
            className="w-full border-0 bg-transparent py-2 text-xs text-text outline-none"
            value={note.tags.join(', ')}
            onChange={(e) => onPatch({ tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
            placeholder="теги через запятую"
          />
        </label>
        <label className="flex flex-1 items-center gap-1.5 rounded-[10px] border border-line bg-bg px-2.5 text-text-faint focus-within:border-text-faint">
          <Folder size={14} />
          <input
            className="w-full border-0 bg-transparent py-2 text-xs text-text outline-none"
            value={note.folder || ''}
            onChange={(e) => onPatch({ folder: e.target.value })}
            placeholder="папка"
            list="brain-folders"
          />
        </label>
        <datalist id="brain-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          className={`grid h-6 w-6 flex-none place-items-center rounded-full border ${
            !note.color ? 'border-text-faint' : 'border-line-soft'
          }`}
          title="Без цвета"
          onClick={() => onPatch({ color: '' })}
        >
          {!note.color && <Check size={12} className="text-text-faint" />}
        </button>
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            className={`h-6 w-6 flex-none rounded-full border-2 ${note.color === c ? 'border-text' : 'border-transparent'}`}
            style={{ background: c }}
            title={c}
            onClick={() => onPatch({ color: c })}
          />
        ))}
      </div>

      <footer className="flex items-center justify-between text-[11px] text-text-faint">
        <span>{(note.links || []).length} исходящих связей</span>
        <button className="flex items-center gap-1 text-text-dim hover:text-danger" onClick={onDelete}>
          <Trash2 size={12} /> Удалить заметку
        </button>
      </footer>
    </article>
  )
}
