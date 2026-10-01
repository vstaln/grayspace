import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Palette, Plus, Tag, Trash2 } from 'lucide-react'
import type { NoteItem } from '../../../preload/index.d'
import { NOTE_CATEGORY_PALETTE } from '../../../shared/noteColors'
import { useConfirm } from './ConfirmDialog'

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20)
}

export default function NotesWidget(): React.JSX.Element {
  const [items, setItems] = useState<NoteItem[]>([])
  const [loading, setLoading] = useState(true)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [category, setCategory] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const confirm = useConfirm()

  useEffect(() => {
    aliveRef.current = true
    let mounted = true
    let loadingInitial = true
    let latestBroadcast: NoteItem[] | null = null
    const unbind = window.api.notes.onChange((next) => {
      if (!mounted) return
      if (loadingInitial) latestBroadcast = next
      else setItems(next)
      if (aliveRef.current) setLoading(false)
    })
    void window.api.notes
      .list()
      .then((next) => {
        if (mounted) setItems(latestBroadcast ?? next)
      })
      .catch(() => {
        if (mounted && !latestBroadcast) setError('Failed to load notes')
      })
      .finally(() => {
        loadingInitial = false
        if (mounted && latestBroadcast) setItems(latestBroadcast)
        if (mounted) setLoading(false)
      })
    return () => {
      aliveRef.current = false
      mounted = false
      unbind()
    }
  }, [])

  const categories = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of items) {
      if (item.category && !map.has(item.category)) map.set(item.category, item.color)
    }
    return Array.from(map.entries()).map(([name, color]) => ({ name, color }))
  }, [items])

  const scoped = useMemo(() => {
    const list = categoryFilter ? items.filter((i) => (i.category ?? null) === categoryFilter) : items
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [items, categoryFilter])

  const add = async (): Promise<void> => {
    const t = title.trim()
    if (!t || creating) return
    setCreating(true)
    try {
      const result = await window.api.notes.create({
        title: t,
        body: body.trim() || undefined,
        tags: parseTags(tagsInput),
        category: (categoryFilter || category.trim()) || undefined
      })
      if (!aliveRef.current) return
      if (result && 'error' in result) {
        setError(result.error)
        return
      }
      setError(null)
      setTitle('')
      setBody('')
      setTagsInput('')
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setCreating(false)
    }
  }

  const remove = (item: NoteItem): void => {
    void confirm(`Delete "${item.title}"?`, { danger: true, title: 'Delete note', confirmLabel: 'Delete' }).then((ok) => {
      if (!ok) return
      void window.api.notes.delete(item.id).catch(() => {})
    })
  }

  const recolor = async (categoryName: string, color: string): Promise<void> => {
    setColorPickerFor(null)
    try {
      const result = await window.api.notes.recolorCategory(categoryName, color)
      if (result && 'error' in result) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center justify-between gap-3 border-b border-line-soft px-3.5 pt-3 pb-2.5">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold tracking-tight text-text">
            {categoryFilter ?? 'All notes'}
          </div>
          {categoryFilter && (
            <button
              type="button"
              className="mt-0.5 text-[11px] text-text-faint transition-colors hover:text-text-dim"
              onClick={() => setCategoryFilter(null)}
            >
              ← All notes
            </button>
          )}
        </div>
        <div className="flex-none rounded-pill border border-line-soft bg-bg-hover/40 px-2 py-0.5 text-[11px] tabular-nums text-text-dim">
          {scoped.length}
        </div>
      </div>

      {categories.length > 0 && (
        <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-line-soft px-3 py-2">
          {categories.map((c) => (
            <div key={c.name} className="group relative">
              <button
                type="button"
                className={`flex items-center gap-1.5 rounded-pill border px-2 py-1 text-[11px] transition-colors ${
                  categoryFilter === c.name ? 'border-line bg-bg-hover text-text' : 'border-line-soft text-text-dim hover:bg-bg-hover/60 hover:text-text'
                }`}
                onClick={() => setCategoryFilter((cur) => (cur === c.name ? null : c.name))}
              >
                <span className="h-2 w-2 flex-none rounded-pill" style={{ backgroundColor: c.color }} />
                {c.name}
              </button>
              <button
                type="button"
                title="Change color"
                aria-label={`Change color for ${c.name}`}
                className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-pill border border-line-soft bg-bg-panel text-text-faint opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  setColorPickerFor((cur) => (cur === c.name ? null : c.name))
                }}
              >
                <Palette size={9} />
              </button>
              {colorPickerFor === c.name && (
                <div className="absolute left-0 top-[calc(100%+4px)] z-20 flex gap-1 rounded-panel border border-line-soft bg-bg-panel p-1.5 shadow-lg">
                  {NOTE_CATEGORY_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className="h-5 w-5 rounded-pill border border-line-soft transition-transform hover:scale-110"
                      style={{ backgroundColor: color }}
                      title={color}
                      onClick={() => void recolor(c.name, color)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div
        className="flex flex-none flex-col gap-1.5 px-3 pb-2 pt-2"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add()
        }}
      >
        <div className="flex items-center gap-1.5 rounded-panel bg-bg-hover/20 px-2.5 py-1.5">
          <Plus size={14} className="flex-none text-text-faint" aria-hidden />
          <input
            className="min-w-0 flex-1 bg-transparent px-px text-[12px] text-text outline-none placeholder:text-text-faint"
            placeholder="New note title…"
            value={title}
            disabled={creating}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
            aria-label="New note title"
          />
          <button
            type="button"
            className="flex h-6 flex-none items-center rounded-panel bg-accent px-2.5 text-[11px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-30"
            disabled={creating || !title.trim()}
            onClick={() => void add()}
          >
            Add
          </button>
        </div>
        <textarea
          className="min-h-[44px] resize-none rounded-panel border border-line-soft bg-transparent px-2.5 py-1.5 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-line"
          placeholder="Note body (optional)"
          value={body}
          disabled={creating}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-panel border border-line-soft bg-transparent px-2.5 py-1 text-[11px] text-text-dim outline-none placeholder:text-text-faint focus:border-line"
            placeholder="Tags, comma separated"
            value={tagsInput}
            disabled={creating}
            onChange={(e) => setTagsInput(e.target.value)}
          />
          {!categoryFilter && (
            <input
              className="min-w-0 flex-1 rounded-panel border border-line-soft bg-transparent px-2.5 py-1 text-[11px] text-text-dim outline-none placeholder:text-text-faint focus:border-line"
              placeholder="Category (optional — color assigned automatically)"
              value={category}
              disabled={creating}
              onChange={(e) => setCategory(e.target.value)}
            />
          )}
        </div>
        {error && (
          <div role="alert" className="flex items-start justify-between gap-2 text-[11px] text-danger">
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="flex-none rounded-panel px-1 leading-none hover:opacity-70">×</button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="flex flex-col gap-2 px-1 pt-4" role="status" aria-label="Loading notes">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-panel bg-bg-hover/60" />
            ))}
          </div>
        ) : scoped.length === 0 ? (
          <p className="px-3 pt-8 text-center text-[12px] leading-relaxed text-text-faint">
            No notes yet. Add one above — or let an agent create one with `orc note create`.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {scoped.map((item) => (
              <NoteCard
                key={item.id}
                item={item}
                editing={editingId === item.id}
                onStartEdit={() => setEditingId(item.id)}
                onStopEdit={() => setEditingId(null)}
                onDelete={() => remove(item)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function NoteCard({
  item,
  editing,
  onStartEdit,
  onStopEdit,
  onDelete
}: {
  item: NoteItem
  editing: boolean
  onStartEdit: () => void
  onStopEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(item.title)
  const [body, setBody] = useState(item.body)
  const [tagsInput, setTagsInput] = useState(item.tags.join(', '))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!editing) {
      setTitle(item.title)
      setBody(item.body)
      setTagsInput(item.tags.join(', '))
    }
  }, [editing, item.title, item.body, item.tags])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.notes.update(item.id, {
        title: title.trim() || item.title,
        body,
        tags: parseTags(tagsInput),
        baseVersion: item.version
      })
      onStopEdit()
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-1.5 rounded-panel border border-line-soft bg-bg-hover/30 p-2.5" style={{ borderLeft: `3px solid ${item.color}` }}>
        <input
          className="rounded-panel border border-line-soft bg-transparent px-2 py-1 text-[12px] text-text outline-none focus:border-line"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <textarea
          className="min-h-[60px] resize-none rounded-panel border border-line-soft bg-transparent px-2 py-1 text-[11px] text-text outline-none focus:border-line"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <input
          className="rounded-panel border border-line-soft bg-transparent px-2 py-1 text-[11px] text-text-dim outline-none focus:border-line"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="Tags, comma separated"
        />
        <div className="flex justify-end gap-1.5">
          <button type="button" className="rounded-panel px-2 py-1 text-[11px] text-text-dim hover:bg-bg-hover" onClick={onStopEdit}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-panel bg-accent px-2.5 py-1 text-[11px] font-semibold text-bg hover:opacity-90 disabled:opacity-40"
            disabled={saving || !title.trim()}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </li>
    )
  }

  return (
    <li
      className="group flex flex-col gap-1 rounded-panel px-2.5 py-2 transition-colors hover:bg-bg-hover/40"
      style={{ borderLeft: `3px solid ${item.color}` }}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onStartEdit}>
          <div className="truncate text-[12.5px] font-medium text-text">{item.title}</div>
          {item.body && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-dim">{item.body}</div>}
        </button>
        <button
          type="button"
          className="grid h-6 w-6 flex-none place-items-center rounded-pill text-text-faint/70 opacity-0 transition-opacity hover:bg-bg-hover hover:text-danger group-hover:opacity-100"
          title="Delete"
          aria-label="Delete note"
          onClick={onDelete}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {(item.tags.length > 0 || item.category) && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {item.category && (
            <span className="flex items-center gap-1 rounded-pill bg-bg-hover px-1.5 py-0.5 text-[9px] text-text-dim">
              <span className="h-1.5 w-1.5 rounded-pill" style={{ backgroundColor: item.color }} />
              {item.category}
            </span>
          )}
          {item.tags.map((tag) => (
            <span key={tag} className="flex items-center gap-0.5 rounded-pill bg-bg-hover px-1.5 py-0.5 text-[9px] text-text-faint">
              <Tag size={8} />
              {tag}
            </span>
          ))}
        </div>
      )}
    </li>
  )
}

