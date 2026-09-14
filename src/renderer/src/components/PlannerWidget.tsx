import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useConfirm } from './ConfirmDialog'
import { Check, ImagePlus, Loader, Paperclip, Plus, Trash2, X, ImageOff } from 'lucide-react'
import DatePicker from './DatePicker'
import type { PlanItem } from '../../../preload/index.d'
import { pasteHasImage, saveImageFromPaste } from '../lib/paste'

type Scope = 'all' | 'today' | 'week' | 'inbox'


function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return todayKey(date)
}

function formatDayShort(key: string): string {
  const today = todayKey()
  if (key === today) return 'Today'
  if (key === shiftDay(today, 1)) return 'Tomorrow'
  if (key === shiftDay(today, -1)) return 'Yesterday'
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en', { day: 'numeric', month: 'short' })
}

function inWeek(day: string | undefined, today: string, weekEnd: string): boolean {
  return Boolean(day && day >= today && day <= weekEnd)
}








export default function PlannerWidget(): React.JSX.Element {
  const [items, setItems] = useState<PlanItem[]>([])
  const [scope, setScope] = useState<Scope>('today')
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set())
  const [today, setToday] = useState(() => todayKey())
  const [pendingCreateAttachments, setPendingCreateAttachments] = useState<string[]>([])
  const [createAttachBusy, setCreateAttachBusy] = useState(false)
  const createFileRef = useRef<HTMLInputElement | null>(null)
  const creatingRef = useRef(false)
  const createAttachBusyRef = useRef(false)
  const pendingIdsRef = useRef<Set<string>>(new Set())
  const aliveRef = useRef(true)
  const confirm = useConfirm()

  useEffect(() => {
    aliveRef.current = true
    let mounted = true
    let loadingInitial = true
    let latestBroadcast: PlanItem[] | null = null
    const unbind = window.api.planner.onChange((next) => {
      if (!mounted) return



      if (loadingInitial) latestBroadcast = next
      else setItems(next)
      if (aliveRef.current) setLoading(false)
    })
    void window.api.planner.list()
      .then((next) => {
        if (mounted) setItems(latestBroadcast ?? next)
      })
      .catch(() => {
        if (mounted && !latestBroadcast) setError('Failed to load planner items')
      })
      .finally(() => {
        loadingInitial = false
        if (mounted && latestBroadcast) setItems(latestBroadcast)
        if (mounted) setLoading(false)
      })
    const dayTimer = setInterval(() => {
      const current = todayKey()
      setToday((prev) => (prev !== current ? current : prev))
    }, 30_000)
    return () => {
      aliveRef.current = false
      mounted = false
      unbind()
      clearInterval(dayTimer)
    }
  }, [])

  const weekEnd = shiftDay(today, 6)

  const projects = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const item of items) {
      const p = item.project?.trim()
      if (!p || seen.has(p)) continue
      seen.add(p)
      list.push(p)
    }
    return list.sort((a, b) => a.localeCompare(b))
  }, [items])

  const scoped = useMemo(() => {
    let list = items
    if (scope === 'today') list = list.filter((i) => i.day === today)
    else if (scope === 'week') list = list.filter((i) => inWeek(i.day, today, weekEnd))
    else if (scope === 'inbox') list = list.filter((i) => !i.day)
    if (projectFilter) list = list.filter((i) => (i.project ?? '') === projectFilter)
    return [...list].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const day = (a.day ?? '').localeCompare(b.day ?? '')
      if (day !== 0) return a.day ? (b.day ? day : -1) : b.day ? 1 : 0
      return a.order - b.order
    })
  }, [items, scope, projectFilter, today, weekEnd])

  const openCount = scoped.filter((i) => !i.done).length
  const totalCount = scoped.length
  const doneCount = totalCount - openCount

  const headerTitle = projectFilter
    ? projectFilter
    : scope === 'today'
      ? 'Today'
      : scope === 'week'
        ? 'This Week'
        : scope === 'inbox'
          ? 'Inbox (No Date)'
          : 'All Tasks'

  const saveFiles = async (files: FileList | File[]): Promise<string[]> => {
    const list = Array.from(files as FileList & Iterable<File>)
    const images = list.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return []
    const paths: string[] = []
    for (const file of images) {
      if (paths.length + pendingCreateAttachments.length >= 12) break
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? 'png') : file.type.split('/')[1] ?? 'png'
        const saved = await window.api.media.saveBytes(bytes, ext)
        if (saved && 'path' in saved && saved.path) paths.push(saved.path)
        else if (saved && 'error' in saved) throw new Error(saved.error)
      } catch (err) {
        if (aliveRef.current) setError(err instanceof Error ? err.message : 'Could not attach image')
      }
    }
    return paths
  }

  const handleCreateAttach = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || createAttachBusyRef.current) return
    createAttachBusyRef.current = true
    setCreateAttachBusy(true)
    try {
      const paths = await saveFiles(files)
      if (aliveRef.current && paths.length) setPendingCreateAttachments((cur) => [...cur, ...paths].slice(0, 12))
    } finally {
      createAttachBusyRef.current = false
      if (aliveRef.current) setCreateAttachBusy(false)
      if (createFileRef.current) createFileRef.current.value = ''
    }
  }

  const handleCreatePaste = async (e: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>): Promise<void> => {
    if (!pasteHasImage(e.nativeEvent)) return
    if (createAttachBusyRef.current) return
    e.preventDefault()
    createAttachBusyRef.current = true
    setCreateAttachBusy(true)
    try {
      const saved = await saveImageFromPaste(e.nativeEvent)
      if (aliveRef.current && saved?.path) setPendingCreateAttachments((cur) => [...cur, saved.path].slice(0, 12))
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : 'Could not paste image')
    } finally {
      createAttachBusyRef.current = false
      if (aliveRef.current) setCreateAttachBusy(false)
    }
  }

  const handleCreateDrop = async (e: React.DragEvent): Promise<void> => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    const hasImage = Array.from(files).some((f) => f.type.startsWith('image/'))
    if (!hasImage) return
    e.preventDefault()
    await handleCreateAttach(files)
  }

  const add = async (): Promise<void> => {
    const text = title.trim()


    if (!text || creating || creatingRef.current || createAttachBusyRef.current) return
    const day =
      scope === 'inbox' || scope === 'all' ? undefined : todayKey()
    creatingRef.current = true
    setCreating(true)
    try {
      const result = await window.api.planner.create({
        title: text,
        day,
        project: (projectFilter || project.trim() || undefined) ?? undefined,
        ...(pendingCreateAttachments.length ? { attachments: pendingCreateAttachments } : {})
      })
      if (!aliveRef.current) return
      if (result && typeof result === 'object' && 'error' in result) {
        setError(result.error)
        return
      }
      setError(null)
      setTitle((current) => (current.trim() === text ? '' : current))
      setPendingCreateAttachments([])
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      creatingRef.current = false
      if (aliveRef.current) setCreating(false)
    }
  }

  const runItemAction = async (item: PlanItem, action: () => Promise<unknown>): Promise<void> => {
    if (pendingIdsRef.current.has(item.id)) return
    pendingIdsRef.current.add(item.id)
    setPendingIds((current) => new Set(current).add(item.id))
    try {
      const result = await action()
      if (!aliveRef.current) return
      if (result && typeof result === 'object' && 'error' in result) setError(String(result.error))
      else setError(null)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      pendingIdsRef.current.delete(item.id)
      if (aliveRef.current) {
        setPendingIds((current) => {
          const next = new Set(current)
          next.delete(item.id)
          return next
        })
      }
    }
  }

  const toggle = (item: PlanItem): void => void runItemAction(item, () => window.api.planner.toggle(item.id, !item.done, item.version))

  const reschedule = (item: PlanItem, day: string): void =>
    void runItemAction(item, () => window.api.planner.update(item.id, { day: day || null, baseVersion: item.version }))

  const remove = (item: PlanItem): void => {
    void confirm(`Delete “${item.title}”?`, {
      danger: true,
      title: 'Delete plan line',
      confirmLabel: 'Delete'
    }).then((ok) => {
      if (ok) void runItemAction(item, () => window.api.planner.delete(item.id))
    })
  }

  const attachToItem = async (item: PlanItem, files: FileList | File[]): Promise<void> => {
    const list = Array.from(files as unknown as File[])
    const images = list.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    const existing = item.attachments ?? []
    if (existing.length >= 12) {
      setError('Maximum 12 photos per task')
      return
    }
    if (pendingIdsRef.current.has(item.id)) return

    pendingIdsRef.current.add(item.id)
    setPendingIds((cur) => new Set(cur).add(item.id))
    try {
      const newPaths: string[] = []
      for (const file of images) {
        if (existing.length + newPaths.length >= 12) break
        const bytes = new Uint8Array(await file.arrayBuffer())
        const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? 'png') : file.type.split('/')[1] ?? 'png'
        const saved = await window.api.media.saveBytes(bytes, ext)
        if (saved && 'path' in saved && saved.path) newPaths.push(saved.path)
        else if (saved && 'error' in saved) throw new Error(saved.error)
      }
      if (newPaths.length) {
        const merged = [...existing, ...newPaths].slice(0, 12)
        const result = await window.api.planner.update(item.id, { attachments: merged, baseVersion: item.version })
        if (!aliveRef.current) return
        if (result && typeof result === 'object' && 'error' in result) setError(String(result.error))
        else setError(null)
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      pendingIdsRef.current.delete(item.id)
      if (aliveRef.current) {
        setPendingIds((cur) => {
          const next = new Set(cur)
          next.delete(item.id)
          return next
        })
      }
    }
  }

  const attachClipboardToItem = async (item: PlanItem, event: ClipboardEvent): Promise<boolean> => {
    if (!pasteHasImage(event)) return false
    event.preventDefault()
    if (pendingIdsRef.current.has(item.id)) return true
    pendingIdsRef.current.add(item.id)
    setPendingIds((cur) => new Set(cur).add(item.id))
    try {
      const saved = await saveImageFromPaste(event)
      if (!saved?.path) return true
      const merged = [...(item.attachments ?? []), saved.path].slice(0, 12)
      const result = await window.api.planner.update(item.id, { attachments: merged, baseVersion: item.version })
      if (!aliveRef.current) return true
      if (result && typeof result === 'object' && 'error' in result) setError(String(result.error))
      else setError(null)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      pendingIdsRef.current.delete(item.id)
      if (aliveRef.current) {
        setPendingIds((cur) => {
          const next = new Set(cur)
          next.delete(item.id)
          return next
        })
      }
    }
    return true
  }

  const removeAttachment = (item: PlanItem, targetIndex: number): void => {
    const next = (item.attachments ?? []).filter((_, idx) => idx !== targetIndex)
    void runItemAction(item, () => window.api.planner.update(item.id, { attachments: next.length ? next : null, baseVersion: item.version }))
  }

  const scopes: { id: Scope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'today', label: 'Today' },
    { id: 'week', label: 'Week' },
    { id: 'inbox', label: 'Inbox' }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {}
      <div className="flex flex-none items-start justify-between gap-3 border-b border-line-soft px-3.5 pt-3 pb-2.5">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold tracking-tight text-text">{headerTitle}</div>
          {projectFilter && (
            <button
              type="button"
              className="mt-0.5 text-[11px] text-text-faint transition-colors hover:text-text-dim"
              onClick={() => setProjectFilter(null)}
            >
              ← All projects
            </button>
          )}
        </div>
        <div
          className="flex-none rounded-pill border border-line-soft bg-bg-hover/40 px-2 py-0.5 text-[11px] tabular-nums text-text-dim"
          title={`${doneCount} completed out of ${totalCount}`}
        >
          {doneCount} of {totalCount}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {}
        {projects.length > 0 && (
          <aside className="hidden w-[118px] min-[380px]:flex flex-none flex-col gap-0.5 overflow-auto border-r border-line-soft px-1.5 py-2">
            <div className="px-1.5 pb-1 text-[9px] font-medium tracking-wider text-text-faint uppercase">
              Projects
            </div>
            <button
              type="button"
              className={`rounded-panel px-1.5 py-1 text-left text-[11px] transition-colors ${
                !projectFilter ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover/60 hover:text-text'
              }`}
              onClick={() => setProjectFilter(null)}
            >
              All
            </button>
            {projects.map((p) => {
              const count = items.filter((i) => i.project === p && !i.done).length
              return (
                <button
                  key={p}
                  type="button"
                  title={p}
                  className={`flex items-center gap-1 rounded-panel px-1.5 py-1 text-left text-[11px] transition-colors ${
                    projectFilter === p
                      ? 'bg-bg-hover text-text'
                      : 'text-text-dim hover:bg-bg-hover/60 hover:text-text'
                  }`}
                  onClick={() => setProjectFilter(p)}
                >
                  <span className="min-w-0 flex-1 truncate">{p}</span>
                  {count > 0 && (
                    <span className="flex-none text-[10px] tabular-nums text-text-faint">{count}</span>
                  )}
                </button>
              )
            })}
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-auto">
          {}
          {projects.length > 0 && (
            <div className="flex-none px-3 pt-2 min-[380px]:hidden">
              <select
                className="w-full rounded-panel border border-line-soft bg-transparent px-2 py-1 text-[11px] text-text-dim outline-none focus:border-line"
                value={projectFilter ?? ''}
                onChange={(e) => setProjectFilter(e.target.value || null)}
                aria-label="Filter by project"
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          )}
          {}
          <div
            className="flex flex-none flex-wrap gap-1 px-3 pt-2.5 pb-1.5"
            role="tablist"
            aria-label="Planner scope"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const delta = e.key === 'ArrowRight' ? 1 : -1
              const idx = scopes.findIndex((s) => s.id === scope)
              const next = (idx + delta + scopes.length) % scopes.length
              setScope(scopes[next].id)
              const chips = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              chips[next]?.focus()
            }}
          >
            {scopes.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={scope === s.id}
                className={`rounded-pill px-2.5 py-1 text-[11px] transition-colors duration-150 ${
                  scope === s.id
                    ? 'bg-bg-hover text-text'
                    : 'text-text-faint hover:bg-bg-hover/50 hover:text-text-dim'
                }`}
                onClick={() => setScope(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {}
          <div
            className="flex flex-none flex-col gap-1.5 px-3 pb-2"
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
            }}
            onDrop={(e) => void handleCreateDrop(e)}
          >
            <div className="flex items-center gap-1.5 rounded-panel bg-bg-hover/20 px-2.5 py-1.5">
              <Plus size={14} className="flex-none text-text-faint" aria-hidden />
              <input
                className="min-w-0 flex-1 bg-transparent px-px text-[12px] text-text outline-none placeholder:text-text-faint"
                placeholder="Add a task…  (paste image or drag & drop)"
                value={title}
                disabled={creating}
                onChange={(e) => setTitle(e.target.value)}
                onPaste={(e) => void handleCreatePaste(e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                aria-label="New planner item"
              />
              <input
                ref={createFileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => void handleCreateAttach(e.target.files)}
              />
              <button
                type="button"
                className="grid h-7 w-7 flex-none place-items-center rounded-pill text-text-faint transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-30"
                disabled={creating || createAttachBusy}
                title="Attach photo"
                aria-label="Attach photo to new task"
                onClick={() => createFileRef.current?.click()}
              >
                {createAttachBusy ? <Loader size={14} className="animate-spin" /> : <Paperclip size={14} />}
              </button>
              <button
                type="button"
                className="flex h-6 flex-none items-center rounded-panel bg-accent px-2.5 text-[11px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-30"
                disabled={creating || createAttachBusy || !title.trim()}
                title="Add"
                aria-label="Add item"
                onClick={() => void add()}
              >
                Add
              </button>
            </div>
            {pendingCreateAttachments.length > 0 && (
              <CreateAttachmentsPreview
                paths={pendingCreateAttachments}
                busy={createAttachBusy}
                onRemove={(indexToRemove) => setPendingCreateAttachments((cur) => cur.filter((_, idx) => idx !== indexToRemove))}
              />
            )}
            {!projectFilter && (
              <input
                className="rounded-panel border border-line-soft bg-transparent px-2.5 py-1 text-[11px] text-text-dim outline-none placeholder:text-text-faint focus:border-line"
                placeholder="Project (optional)"
                value={project}
                disabled={creating}
                onChange={(e) => setProject(e.target.value)}
                onPaste={(e) => void handleCreatePaste(e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                aria-label="Project"
              />
            )}
            {error && (
              <div role="alert" className="flex items-start justify-between gap-2 text-[11px] text-danger">
                <span className="min-w-0 flex-1">{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  aria-label="Dismiss error"
                  className="flex-none rounded-panel px-1 leading-none hover:opacity-70"
                >
                  ×
                </button>
              </div>
            )}
            <p className="text-[10px] leading-relaxed text-text-faint">
              Tip: paste a screenshot (Ctrl+V), drag &amp; drop an image, or click <Paperclip size={10} className="inline" /> — photos are saved with the task.
            </p>
          </div>

          {}
          <div className="px-2 pb-2">
            {loading ? (
              <div className="flex flex-col gap-2 px-1 pt-4" role="status" aria-label="Loading tasks">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-panel bg-bg-hover/60" />
                ))}
              </div>
            ) : scoped.length === 0 ? (
              <Empty
                text={
                  scope === 'today'
                    ? 'Nothing planned for today. Add a task above — items persist and sync with CLI & Planner.'
                    : scope === 'inbox'
                      ? 'No unscheduled tasks. Use inbox to drop ideas and assign dates later.'
                      : 'Plan list is empty. Add tasks above to track your day.'
                }
              />
            ) : (
              <ul className="flex flex-col">
                {scoped.map((item, index) => (
                  <PlanRow
                    key={item.id}
                    item={item}
                    index={index + 1}
                    showDay={scope !== 'today'}
                    pending={pendingIds.has(item.id)}
                    onToggle={() => toggle(item)}
                    onRemove={() => remove(item)}
                    onReschedule={(day) => reschedule(item, day)}
                    onAttachFiles={(files) => void attachToItem(item, files)}
                    onPasteImage={(e) => void attachClipboardToItem(item, e)}
                    onRemoveAttachment={(targetIndex) => removeAttachment(item, targetIndex)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="px-3 pt-8 text-center text-[12px] leading-relaxed text-text-faint">{text}</p>
}

function CreateAttachmentsPreview({
  paths,
  busy,
  onRemove
}: {
  paths: string[]
  busy: boolean
  onRemove: (index: number) => void
}): React.JSX.Element {
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const key = paths.join('\0')
  useEffect(() => {
    let cancelled = false
    setUrls({})
    void Promise.all(
      paths.map(async (path) => {
        try {
          return [path, await window.api.media.dataUrl(path)] as const
        } catch {
          return [path, null] as const
        }
      })
    ).then((pairs) => {
      if (!cancelled) setUrls(Object.fromEntries(pairs))
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return (
    <div className="flex flex-wrap gap-1.5 rounded-panel border border-dashed border-line-soft bg-bg-hover/20 px-2 py-2">
      {paths.map((path, idx) => {
        const url = urls[path]
        const loaded = Object.prototype.hasOwnProperty.call(urls, path)
        return (
          <div key={`${path}-${idx}`} className="group relative h-16 w-20 overflow-hidden rounded-panel border border-line-soft bg-bg-hover">
            {!loaded ? (
              <span className="grid h-full w-full place-items-center text-text-faint">
                <Loader size={14} className="animate-spin" />
              </span>
            ) : url ? (
              <img src={url} alt="attachment" className="h-full w-full object-cover" />
            ) : (
              <span className="grid h-full w-full place-items-center text-text-faint">
                <ImageOff size={14} />
              </span>
            )}
            <button
              type="button"
              className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-pill bg-bg-panel text-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 hover:bg-bg-raise"
              title="Remove"
              aria-label="Remove attachment"
              onClick={() => onRemove(idx)}
            >
              <X size={10} />
            </button>
          </div>
        )
      })}
      {busy && (
        <span className="grid h-16 w-20 place-items-center rounded-panel border border-line-soft bg-bg-hover text-text-faint">
          <Loader size={14} className="animate-spin" />
        </span>
      )}
    </div>
  )
}

function PlanRow({
  item,
  index,
  showDay,
  pending,
  onToggle,
  onRemove,
  onReschedule,
  onAttachFiles,
  onPasteImage,
  onRemoveAttachment
}: {
  item: PlanItem
  index: number
  showDay: boolean
  pending: boolean
  onToggle: () => void
  onRemove: () => void
  onReschedule: (day: string) => void
  onAttachFiles: (files: FileList) => void
  onPasteImage: (e: ClipboardEvent) => void
  onRemoveAttachment: (index: number) => void
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)

  return (
    <li
      className={`group flex flex-col gap-1 rounded-panel px-2 py-2 transition-colors focus-within:bg-bg-hover/40 ${dragOver ? 'bg-accent/10 ring-1 ring-accent/30' : 'hover:bg-bg-hover/40'}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false)
        const files = e.dataTransfer?.files
        if (files && files.length) {
          e.preventDefault()
          onAttachFiles(files)
        }
      }}
      onPaste={(e) => {

        if (pasteHasImage(e.nativeEvent as unknown as ClipboardEvent)) {
          void onPasteImage(e.nativeEvent as unknown as ClipboardEvent)
        }
      }}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          className={`mt-0.5 grid h-[18px] w-[18px] flex-none place-items-center rounded-pill border transition-colors duration-150 ${
            item.done
              ? 'border-ok bg-ok/20 text-ok'
              : 'border-line text-transparent hover:border-ok hover:text-ok/70'
          }`}
          title={item.done ? 'Mark incomplete' : 'Mark completed'}
          aria-label={item.done ? 'Mark incomplete' : 'Mark completed'}
          aria-pressed={item.done}
          disabled={pending}
          onClick={onToggle}
        >
          <Check size={11} strokeWidth={2.5} />
        </button>

        <div className="min-w-0 flex-1 pt-px">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="flex-none text-[11px] tabular-nums text-text-faint">{index}</span>
            <span
              className={`min-w-0 text-[12.5px] leading-snug break-words ${
                item.done ? 'text-text-faint line-through' : 'text-text'
              }`}
              title={item.note || item.title}
            >
              {item.title}
            </span>
          </div>
          {(item.note || item.project || item.time || showDay) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[18px] text-[10px] text-text-faint">
              {item.project && <span className="text-text-dim">{item.project}</span>}
              {showDay && (
                <DatePicker
                  value={item.day ?? ''}
                  onChange={onReschedule}
                  placeholder="No date"
                  ariaLabel={`Schedule date for ${item.title}`}
                  disabled={pending}
                  formatValue={formatDayShort}
                  className="-mx-1 flex h-auto flex-none items-center gap-1 rounded-panel border border-transparent px-1 py-0 text-[10px] tabular-nums text-text-faint transition-colors hover:border-line-soft hover:text-text-dim"
                />
              )}
              {item.time && <span className="tabular-nums">{item.time}</span>}
              {item.note && <span className="truncate opacity-80">{item.note}</span>}
            </div>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onAttachFiles(e.target.files)
            e.target.value = ''
          }}
        />

        <div className="mt-0.5 flex flex-none items-center gap-0.5">
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-pill text-text-faint/70 transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-30"
            title={item.attachments?.length ? `Add photo (${item.attachments.length}/12)` : 'Attach photo'}
            aria-label="Attach photo"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
          >
            {pending ? <Loader size={12} className="animate-spin" /> : <ImagePlus size={14} />}
          </button>

          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-pill text-text-faint/70 transition-colors hover:bg-bg-hover hover:text-text group-hover:text-text-faint group-focus-within:text-text-faint hover:!text-danger disabled:opacity-30"
            title="Delete"
            aria-label="Delete item"
            disabled={pending}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {item.attachments && item.attachments.length > 0 && (
        <PlanAttachments attachments={item.attachments} onRemove={onRemoveAttachment} pending={pending} />
      )}

      {dragOver && (
        <div className="ml-[28px] flex items-center gap-1.5 rounded-panel border border-dashed border-accent/40 bg-accent/10 px-2 py-1 text-[10px] text-accent">
          <ImagePlus size={12} /> Drop image to attach
        </div>
      )}
    </li>
  )
}

function PlanAttachments({
  attachments,
  onRemove,
  pending
}: {
  attachments: string[]
  onRemove: (index: number) => void
  pending: boolean
}): React.JSX.Element {
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const key = attachments.join('\0')

  useEffect(() => {
    let cancelled = false
    setUrls({})
    void Promise.all(
      attachments.map(async (path) => {
        try {
          return [path, await window.api.media.dataUrl(path)] as const
        } catch {
          return [path, null] as const
        }
      })
    ).then((pairs) => {
      if (!cancelled) setUrls(Object.fromEntries(pairs))
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return (
    <div className="ml-[28px] flex flex-wrap gap-1.5 pt-1">
      {attachments.map((path, idx) => {
        const url = urls[path]
        const loaded = Object.prototype.hasOwnProperty.call(urls, path)
        return (
          <div
            key={`${path}-${idx}`}
            className="group/thumb relative h-16 w-20 overflow-hidden rounded-panel border border-line-soft bg-bg-hover"
            title={path}
          >
            {!loaded ? (
              <span className="grid h-full w-full place-items-center text-text-faint" role="status">
                <Loader size={14} className="animate-spin" aria-hidden />
              </span>
            ) : url ? (
              <a href={url} target="_blank" rel="noreferrer" className="block h-full w-full">
                <img className="h-full w-full object-cover transition-opacity hover:opacity-90" src={url} alt="Plan attachment" />
              </a>
            ) : (
              <span className="grid h-full w-full place-items-center text-text-faint">
                <ImageOff size={14} aria-hidden />
              </span>
            )}
            <button
              type="button"
              className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-pill bg-bg-panel text-text opacity-0 transition-opacity group-hover/thumb:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 hover:bg-bg-raise disabled:opacity-50"
              title="Remove photo"
              aria-label="Remove photo"
              disabled={pending}
              onClick={() => onRemove(idx)}
            >
              <X size={10} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
