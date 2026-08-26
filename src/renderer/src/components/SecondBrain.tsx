import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Check, FilePlus2, Folder, Link2, Loader, Search, Tag, Trash2, X } from 'lucide-react'
import NoteAttachments from './NoteAttachments'
import { insertAt, pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { useSettings } from '../hooks/useSettings'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useConfirm } from './ConfirmDialog'
import type { BrainNote, LinkSyntax } from '../../../preload/index.d'

interface Props {
  workspaceDir: string | null
  onClose(): void
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

/** Human-readable form of the active link syntax, shown in the header. */
function syntaxHint(syntax: LinkSyntax): React.ReactNode {
  if (syntax === 'dollar') return <>Links: <code>$Note Title</code></>
  if (syntax === 'wiki') return <>Links: <code>[[Note Title]]</code></>
  return <>Links: <code>[[Title]]</code> or <code>$Title</code></>
}

export default function SecondBrain({
  workspaceDir,
  onClose
}: Props): React.JSX.Element {
  const { settings } = useSettings()
  const confirm = useConfirm()
  const [notes, setNotes] = useState<BrainNote[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [save, setSave] = useState<SaveState>('saved')
  const [trash, setTrash] = useState<BrainNote[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  // The panel mounts only while open; the trap's cleanup restores focus to the
  // element that was focused before it opened (P2-206).
  useFocusTrap(panelRef, true)

  const note = notes.find((n) => n.id === selected) || null

  const reload = useCallback(async (): Promise<BrainNote[]> => {
    // Later reloads win: a stale list landing after a create/delete/restore
    // would roll the UI back to pre-action state (P2-220).
    const seq = ++reloadSeq.current
    try {
      const { notes: next } = await window.api.brain.list()
      if (seq !== reloadSeq.current) return next
      setNotes(next)
      if (seq !== reloadSeq.current) return next
      setTrash(await window.api.brain.trash())
      setError(null)
      return next
    } catch {
      setError('Failed to load notes')
      return []
    }
  }, [])
  const reloadSeq = useRef(0)

  useEffect(() => {
    void reload().then((next) => setSelected((current) => current ?? next[0]?.id ?? null))
  }, [reload])

  // MCP/other widgets mutate the same store — stay live without a remount.
  // `error` must hold the guard too: a failed write means the editor holds
  // text main does not, and reload() would roll it back (mirror of P2-218).
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    return window.api.brain.onChange(() => {
      if (saveRef.current === 'dirty' || saveRef.current === 'saving' || saveRef.current === 'error') return
      void reload()
    })
  }, [reload])

  // The filter concatenates and lowercases the full body of every note, so
  // running it on each keystroke made typing into the search box jank on
  // large brains. The input stays controlled by `query` (instant echo); the
  // expensive filtering reads a deferred copy that React computes after the
  // keystroke commit (PERF-brain-search).
  const deferredQuery = useDeferredValue(query)

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    return notes.filter((n) => !q || `${n.title} ${n.content} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q))
  }, [notes, deferredQuery])

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

  const creatingRef = useRef(false)

  const create = async (title = 'New Note', content = ''): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true
    setError(null)
    try {
      const created = await window.api.brain.create({
        title,
        content,
        tags: [],
        projectDir: workspaceDir || undefined
      })
      if (!created || 'error' in created) {
        setError('Failed to create note')
        return
      }
      await reload()
      selectNote(created.id)
    } catch {
      setError('Failed to create note')
    } finally {
      creatingRef.current = false
    }
  }

  const remove = async (): Promise<void> => {
    if (!note) return
    const ok = await confirm(
      `Move note "${note.title}" to trash? It will be removed from the list, and can be restored within 30 days.`,
      { danger: true, confirmLabel: 'Move to Trash' }
    )
    if (!ok) return
    setError(null)
    try {
      const result = await window.api.brain.delete(note.id)
      if (result && 'error' in result) {
        setError(result.error)
        return
      }
      const next = await reload()
      setSelected(next.find((n) => n.id !== note.id)?.id ?? null)
    } catch {
      setError('Failed to delete note')
    }
  }

  const restoreNote = async (id: string): Promise<void> => {
    setError(null)
    try {
      const result = await window.api.brain.restore(id)
      if (result && 'error' in result) {
        setError(result.error)
        return
      }
      await reload()
    } catch {
      setError('Failed to restore note')
    }
  }

  const purgeNote = async (id: string, title: string): Promise<void> => {
    const ok = await confirm(`Permanently delete note "${title}"? This action cannot be undone.`, {
      danger: true,
      confirmLabel: 'Delete Permanently'
    })
    if (!ok) return
    setError(null)
    try {
      const result = await window.api.brain.purge(id)
      if (result && 'error' in result) {
        setError(result.error)
        return
      }
      await reload()
    } catch {
      setError('Failed to delete note')
    }
  }

  /** Optimistic local edit; the debounced writer below persists it. */
  const patch = (changes: Partial<BrainNote>): void => {
    if (!note) return
    setNotes((list) => list.map((n) => (n.id === note.id ? { ...n, ...changes } : n)))
    // Synchronous marker of "typed since the last persisted write", so the
    // unmount/switch flush below never depends on a state effect having run
    // (P2-219: closing right after a keystroke must not lose it).
    latestDirty.current = true
    setSave('dirty')
  }

  const latestDirty = useRef(false)

  // Coalesce keystrokes into one write so typing never blocks on disk I/O.
  // Writes are serialized: a second update scheduled while the first is still
  // on the wire snapshots the same (not yet bumped) baseVersion and is
  // guaranteed to be rejected as a conflict — a phantom "save error" while the
  // editor text is intact. While a write is in flight the next one waits.
  const pending = useRef<BrainNote | null>(null)
  pending.current = note
  const saveInFlightRef = useRef(false)
  // A save is "pending" from the first keystroke until its reply lands — this
  // pair (not raw `save`) gates the save effect below.
  const pendingSave = save === 'dirty' || save === 'saving'
  useEffect(() => {
    // Gate on `pendingSave`, not raw `save`: flipping to 'saving' inside
    // attempt() used to tear this effect down mid-flight (`save` was a dep),
    // so the reply path was unreachable, the header stuck on "saving…" and
    // the reload guard below stayed shut forever (UI-audit P0).
    if (!pendingSave || !pending.current) return
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const attempt = async (): Promise<void> => {
      if (disposed) return
      // Snapshot at fire time, not schedule time: a save that completes while
      // the timer is pending merges a bumped version into `pending.current`, and
      // a snapshot captured earlier would carry a baseVersion the disk already
      // superseded (update rejected → edits stuck unsaved until the next key).
      const snapshot = pending.current
      if (!snapshot) return
      if (saveInFlightRef.current) {
        retryTimer = setTimeout(() => void attempt(), 250)
        return
      }
      saveInFlightRef.current = true
      setSave('saving')
      try {
        const result = await window.api.brain.update(snapshot.id, {
          title: snapshot.title,
          content: snapshot.content,
          tags: snapshot.tags,
          folder: snapshot.folder,
          color: snapshot.color,
          baseVersion: snapshot.version
        })
        // Bus failures return `{ error }` rather than throwing.
        if (result && !('error' in result)) {
          const { notes: fresh } = await window.api.brain.list()
          // Keep server-derived fields (links, unresolved) without clobbering typing.
          // Merged even when a keystroke re-ran the effect (`disposed`): dropping
          // the bumped version would doom the next write to a baseVersion conflict.
          setNotes((list) =>
            list.map((n) => {
              const server = fresh.find((f) => f.id === n.id)
              return server
                ? {
                    ...n,
                    links: server.links,
                    unresolved: server.unresolved,
                    updatedAt: server.updatedAt,
                    version: server.version
                  }
                : n
            })
          )
          if (!disposed) setSave((current) => (current === 'saving' ? 'saved' : current))
        } else if (!disposed) {
          setSave('error')
        }
      } catch {
        // The editor keeps the typed text; the next keystroke retries (P2-218).
        if (!disposed) setSave('error')
      } finally {
        saveInFlightRef.current = false
      }
    }
    const timer = setTimeout(() => void attempt(), 450)
    return () => {
      disposed = true
      clearTimeout(timer)
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
    // `version` is deliberately not a dep: a successful save merges a bumped
    // version into the note, and re-running the effect then would clear the
    // timer scheduled for keystrokes typed while that save was in flight.
  }, [pendingSave, note?.title, note?.content, note?.tags, note?.folder, note?.color])

  // Closing the panel while a keystroke is still pending must not drop the
  // last edit — flush it on unmount (DI-003).
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = save === 'dirty'
    if (save === 'saved') latestDirty.current = false
  }, [save])
  useEffect(() => {
    return () => {
      const pendingNote = latestDirty.current ? pending.current : null
      if (pendingNote) {
        void window.api.brain.update(pendingNote.id, {
          title: pendingNote.title,
          content: pendingNote.content,
          tags: pendingNote.tags,
          folder: pendingNote.folder,
          color: pendingNote.color,
          baseVersion: pendingNote.version
        }).catch(() => {})
      }
    }
  }, [])

  /** Flushes a dirty note before the user switches away from it. */
  const selectNote = useCallback(
    (id: string): void => {
      if (id === selected) return
      const leaving = pending.current
      if (leaving && latestDirty.current && leaving.id !== id) {
        void window.api.brain.update(leaving.id, {
          title: leaving.title,
          content: leaving.content,
          tags: leaving.tags,
          folder: leaving.folder,
          color: leaving.color,
          baseVersion: leaving.version
        }).catch(() => {})
      }
      setSelected(id)
    },
    [selected]
  )

  // Escape closes the panel — matches KanbanBoard's expectation that a
  // full-screen modal responds to the same key the user reaches for first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Opens a note by title, creating it when the link is still unresolved. */
  const openByTitle = async (title: string): Promise<void> => {
    const existing = notes.find((n) => n.title.toLowerCase() === title.trim().toLowerCase())
    if (existing) {
      selectNote(existing.id)
      return
    }
    await create(title.trim())
  }

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Second Brain"
      data-testid="brain-panel"
      className="brain-panel-shell fixed inset-[52px_24px_24px_80px] z-[12000] flex flex-col overflow-hidden rounded-[10px] border border-line shadow-[0_30px_90px_rgba(0,0,0,0.75)] glass:border-line-soft glass:bg-bg-panel/72 glass:backdrop-blur-2xl glass:backdrop-saturate-150"
    >
      <header className="flex flex-none items-center justify-between gap-4 border-b border-line-soft bg-bg-raise px-4 py-3.5 glass:bg-transparent">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <Brain size={17} className="text-text-dim" /> Second Brain
          </h2>
          <p className="mt-1 text-[11px] text-text-faint">
            {syntaxHint(settings.linkSyntax)} · configure syntax in Settings
          </p>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <button
            className="flex items-center gap-1.5 rounded-[10px] bg-accent px-3.5 py-1.5 text-xs font-semibold text-bg transition-opacity duration-150 hover:opacity-90"
            onClick={() => void create()}
            data-testid="brain-new-note"
          >
            <FilePlus2 size={14} /> New Note
          </button>
          <button
            className="grid h-8 w-8 place-items-center rounded-[10px] border border-line bg-bg-hover/40 text-text transition-colors duration-150 hover:bg-bg-hover"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {error && <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div>}

      <div
        className={`grid min-h-0 flex-1 ${note ? 'grid-cols-[290px_minmax(0,1fr)_236px]' : 'grid-cols-[290px_minmax(0,1fr)]'} max-lg:grid-cols-[240px_minmax(0,1fr)]`}
      >
          <aside className="flex flex-col gap-1.5 overflow-auto border-r border-line-soft p-2.5">
            <label className="flex flex-none items-center gap-1.5 rounded-[10px] border border-line bg-bg px-2.5 text-text-faint focus-within:border-text-faint">
              <Search size={14} />
              <input
                className="w-full border-0 bg-transparent px-px py-2 text-xs text-text outline-none"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes…"
                aria-label="Search notes"
              />
            </label>
            {grouped.map(([folder, items]) => (
              <React.Fragment key={folder || '__none__'}>
                {grouped.length > 1 && (
                  <div className="mt-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wide text-text-faint uppercase first:mt-0">
                    <Folder size={11} />
                    {folder || 'Uncategorized'}
                  </div>
                )}
                {items.map((n) => (
                  <button
                    key={n.id}
                    className={`block w-full rounded-[10px] border border-transparent p-2.5 text-left text-text transition-colors duration-150 hover:bg-bg-hover ${
                      selected === n.id ? 'border-line bg-bg-hover' : ''
                    }`}
                    onClick={() => selectNote(n.id)}
                    aria-current={selected === n.id ? 'true' : undefined}
                  >
                    <b className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
                      {n.color && <span className="h-2 w-2 flex-none rounded-full" style={{ background: n.color }} aria-hidden />}
                      <span className="truncate">{n.title || 'Untitled'}</span>
                    </b>
                    <span className="mt-1 block truncate text-[11px] text-text-faint">{n.content.slice(0, 90) || 'Empty note'}</span>
                    {((n.tags || []).length > 0 || (n.links || []).length > 0) && (
                      <small className="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-dim">
                        {(n.tags || []).length > 0 && (
                          <span className="flex items-center gap-1">
                            <Tag size={11} />
                            {(n.tags || []).join(' · ')}
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
              <div className="m-auto text-center text-xs text-text-faint">{query ? 'No notes found' : 'No notes yet'}</div>
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
                    Trash ({trash.length})
                  </span>
                  <span className="text-text-faint">{showTrash ? '−' : '+'}</span>
                </button>
                {showTrash &&
                  trash.map((n) => (
                    <div key={n.id} className="flex w-full items-center gap-1 rounded-[10px] border border-dashed border-line-soft p-1.5">
                      <span className="block min-w-0 flex-1 truncate text-[11px] text-text-faint">{n.title || 'Untitled'}</span>
                      <button
                        className="flex-none rounded-[10px] border border-line px-1.5 py-0.5 text-[10px] text-text hover:bg-bg-hover"
                        title="Restore"
                        onClick={() => void restoreNote(n.id)}
                      >
                        Restore
                      </button>
                      <button
                        className="flex-none rounded-[10px] border border-danger/40 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/15"
                        title="Delete Permanently"
                        onClick={() => void purgeNote(n.id, n.title)}
                      >
                        Delete
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
                <LinkGroup title="Outgoing Links" notes={outgoing} onOpen={selectNote} />
                <LinkGroup title="Backlinks" notes={backlinks} onOpen={selectNote} />
                {(note.unresolved || []).length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <h4 className="text-[11px] font-semibold tracking-wide text-text-faint uppercase">Unresolved Links</h4>
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
            <div className="m-auto text-center text-xs text-text-faint">Select or create a note</div>
          )}
        </div>
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
      {!notes.length && <p className="text-[11px] text-text-faint">empty</p>}
    </div>
  )
}

/** The editor itself: title, body with link autocomplete, tags, save status. */
/** Small, tasteful accent palette — matches the swatches used on the graph. */
const NOTE_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6']

/** Human names for the swatch tooltips / screen-reader labels (raw hex reads terribly). */
const NOTE_COLOR_NAMES: Record<string, string> = {
  '#f87171': 'Red',
  '#fb923c': 'Orange',
  '#fbbf24': 'Amber',
  '#a3e635': 'Lime',
  '#34d399': 'Emerald',
  '#22d3ee': 'Cyan',
  '#60a5fa': 'Blue',
  '#a78bfa': 'Violet',
  '#f472b6': 'Pink'
}

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
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [suggest, setSuggest] = useState<{ token: string; start: number; items: BrainNote[]; index: number } | null>(null)
  const [tagInput, setTagInput] = useState(() => (note.tags || []).join(', '))
  /** Why the last image paste produced nothing; cleared on the next attempt. */
  const [pasteError, setPasteError] = useState<string | null>(null)
  // A keystroke patches tags live, which would re-enter this effect and reset
  // the field to the trimmed/joined form — and an external brain change would
  // blank what the user is mid-typing. Leave the input alone while focused.
  const tagFocusedRef = useRef(false)

  useEffect(() => {
    if (!tagFocusedRef.current) setTagInput((note.tags || []).join(', '))
  }, [note.id, note.tags])

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
    }
  }, [])

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
    setPasteError(null)
    const area = e.currentTarget
    const { selectionStart, selectionEnd, value } = area
    try {
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
    } catch (err) {
      // See NoteWidget's copy of this handler: a silent catch here meant an
      // oversized paste looked exactly like a dead editor.
      setPasteError(err instanceof Error ? err.message : 'Could not paste that image')
    }
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
          placeholder="Title"
          aria-label="Note title"
        />
        <span className="flex flex-none items-center gap-1.5 text-[11px] text-text-faint" role="status" aria-live="polite">
          {save === 'saved' && (
            <>
              <Check size={13} /> saved
            </>
          )}
          {save === 'saving' && (
            <>
              <Loader size={13} className="animate-spin" /> saving…
            </>
          )}
          {save === 'dirty' && <>unsaved changes</>}
          {save === 'error' && <>save error — changes kept in editor</>}
        </span>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-text-faint">
        <span>{note.projectDir ? `Project: ${note.projectDir.split(/[\\/]/).pop()}` : 'Global Note'}</span>
        <span>· updated {new Date(note.updatedAt).toLocaleString()}</span>
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
          onBlur={() => {
            if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current)
            blurTimerRef.current = setTimeout(() => {
              blurTimerRef.current = null
              setSuggest(null)
            }, 120)
          }}
          placeholder={
            syntax === 'dollar'
              ? 'Write freely. Link to a note: $Note Title'
              : 'Write freely. Link to a note: [[Note Title]]'
          }
          aria-label="Note content"
        />
        {pasteError && (
          <div
            role="alert"
            className="absolute inset-x-2.5 top-2.5 z-20 rounded-[8px] border border-danger/30 bg-danger/12 px-2.5 py-1.5 text-[11px] text-danger shadow-lg"
          >
            {pasteError}
          </div>
        )}
        {suggest && (
          <div
            role="listbox"
            aria-label="Note link suggestions"
            className="absolute bottom-2.5 left-2.5 z-10 max-h-52 w-64 overflow-auto rounded-[10px] border border-line bg-bg-panel p-1 shadow-2xl glass:bg-bg-panel/90 glass:backdrop-blur-xl"
          >
            {suggest.items.map((item, i) => (
              <button
                key={item.id}
                role="option"
                aria-selected={i === suggest.index}
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
            className="w-full border-0 bg-transparent px-px py-2 text-xs text-text outline-none"
            value={tagInput}
            onFocus={() => {
              tagFocusedRef.current = true
            }}
            onChange={(e) => {
              setTagInput(e.target.value)
              onPatch({ tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })
            }}
            onBlur={() => {
              tagFocusedRef.current = false
              const cleaned = tagInput.split(',').map((x) => x.trim()).filter(Boolean)
              setTagInput(cleaned.join(', '))
              onPatch({ tags: cleaned })
            }}
            placeholder="tags (comma separated)"
            aria-label="Tags (comma separated)"
          />
        </label>
        <label className="flex flex-1 items-center gap-1.5 rounded-[10px] border border-line bg-bg px-2.5 text-text-faint focus-within:border-text-faint">
          <Folder size={14} />
          <input
            className="w-full border-0 bg-transparent px-px py-2 text-xs text-text outline-none"
            value={note.folder || ''}
            onChange={(e) => onPatch({ folder: e.target.value })}
            placeholder="folder"
            aria-label="Folder"
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
          className={`grid h-6 w-6 flex-none place-items-center rounded-full border transition-colors duration-150 ${
            !note.color ? 'border-text-faint' : 'border-line-soft'
          }`}
          title="No color"
          aria-label="No color"
          aria-pressed={!note.color}
          onClick={() => onPatch({ color: '' })}
        >
          {!note.color && <Check size={12} className="text-text-faint" />}
        </button>
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            className={`h-6 w-6 flex-none rounded-full border-2 transition-transform duration-150 ${note.color === c ? 'scale-110 border-text' : 'border-transparent hover:scale-105'}`}
            style={{ background: c }}
            title={NOTE_COLOR_NAMES[c]}
            aria-label={`${NOTE_COLOR_NAMES[c]} color`}
            aria-pressed={note.color === c}
            onClick={() => onPatch({ color: c })}
          />
        ))}
      </div>

      <footer className="flex items-center justify-between text-[11px] text-text-faint">
        <span>{(note.links || []).length} outgoing links</span>
        <button
          className="flex items-center gap-1 text-text-dim transition-colors duration-150 hover:text-danger"
          onClick={onDelete}
          aria-label="Delete note"
        >
          <Trash2 size={12} /> Delete note
        </button>
      </footer>
    </article>
  )
}
