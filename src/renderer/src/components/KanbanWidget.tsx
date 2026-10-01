import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { PlanItem, PlanStatus } from '../../../preload/index.d'

const COLUMNS: { status: PlanStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' }
]

function statusOf(item: PlanItem): PlanStatus {
  return item.status ?? (item.done ? 'done' : 'todo')
}

function readProjectFilter(widgetId: string): string | null {
  try {
    const value = localStorage.getItem(`orcspace-kanban-project:${widgetId}`)
    return value && value.length <= 200 ? value : null
  } catch {
    return null
  }
}

export default function KanbanWidget({ widgetId }: { widgetId: string }): React.JSX.Element {
  const [items, setItems] = useState<PlanItem[]>([])
  const [projectFilter, setProjectFilter] = useState<string | null>(() => readProjectFilter(widgetId))
  const [dragOverColumn, setDragOverColumn] = useState<PlanStatus | null>(null)
  const [addingTo, setAddingTo] = useState<PlanStatus | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    let mounted = true
    void window.api.planner
      .list()
      .then((next) => {
        if (mounted) setItems(next)
      })
      .catch(() => {})
    const unbind = window.api.planner.onChange((next) => {
      if (mounted) setItems(next)
    })
    return () => {
      aliveRef.current = false
      mounted = false
      unbind()
    }
  }, [])

  useEffect(() => {
    try {
      if (projectFilter) localStorage.setItem(`orcspace-kanban-project:${widgetId}`, projectFilter)
      else localStorage.removeItem(`orcspace-kanban-project:${widgetId}`)
    } catch {}
  }, [widgetId, projectFilter])

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

  const scoped = useMemo(
    () => (projectFilter ? items.filter((i) => (i.project ?? '') === projectFilter) : items),
    [items, projectFilter]
  )

  const columns = useMemo(() => {
    const map = new Map<PlanStatus, PlanItem[]>(COLUMNS.map((c) => [c.status, []]))
    for (const item of scoped) map.get(statusOf(item))?.push(item)
    for (const list of map.values()) list.sort((a, b) => a.order - b.order)
    return map
  }, [scoped])

  const moveTo = async (item: PlanItem, status: PlanStatus): Promise<void> => {
    if (statusOf(item) === status) return
    try {
      const result = await window.api.planner.update(item.id, { status, baseVersion: item.version })
      if (!aliveRef.current) return
      if ('error' in result) setActionError(result.error)
      else setActionError(null)
    } catch (error) {
      if (aliveRef.current) setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const addCard = async (status: PlanStatus): Promise<void> => {
    const title = draftTitle.trim()
    if (!title) return
    try {
      const result = await window.api.planner.create({ title, status, project: projectFilter ?? undefined })
      if ('error' in result) {
        if (aliveRef.current) setActionError(result.error)
        return
      }
      if (aliveRef.current) {
        setActionError(null)
        setDraftTitle('')
        setAddingTo(null)
      }
    } catch (error) {
      if (aliveRef.current) setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-line-soft px-3.5 py-2.5">
        <div className="text-[14px] font-semibold tracking-tight text-text">{projectFilter ?? 'Board'}</div>
        {projects.length > 0 && (
          <select
            className="rounded-panel border border-line-soft bg-transparent px-2 py-1 text-[11px] text-text-dim outline-none focus:border-line"
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
        )}
      </div>

      {actionError && <div role="alert" className="flex-none px-3 py-1 text-[10px] text-danger">{actionError}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-hidden p-2.5">
        {COLUMNS.map(({ status, label }) => {
          const cards = columns.get(status) ?? []
          return (
            <div
              key={status}
              className={`flex min-h-0 flex-col rounded-panel border transition-colors ${
                dragOverColumn === status ? 'border-accent/50 bg-accent/5' : 'border-line-soft bg-bg-hover/10'
              }`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverColumn(status)
              }}
              onDragLeave={() => setDragOverColumn((cur) => (cur === status ? null : cur))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverColumn(null)
                const id = e.dataTransfer.getData('text/plain')
                const item = items.find((i) => i.id === id)
                if (item) void moveTo(item, status)
              }}
            >
              <div className="flex flex-none items-center justify-between px-2.5 py-2">
                <span className="text-[11px] font-semibold tracking-wide text-text-dim uppercase">{label}</span>
                <span className="rounded-pill bg-bg-hover px-1.5 py-0.5 text-[10px] tabular-nums text-text-faint">{cards.length}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {cards.map((item) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', item.id)}
                    className="cursor-grab rounded-panel border border-line-soft bg-bg-panel px-2.5 py-2 text-[12px] text-text shadow-sm active:cursor-grabbing"
                  >
                    <div className="leading-snug">{item.title}</div>
                    {item.project && <div className="mt-1 text-[10px] text-text-faint">{item.project}</div>}
                  </div>
                ))}
                {addingTo === status ? (
                  <div className="flex items-center gap-1 rounded-panel border border-line-soft bg-bg-panel px-2 py-1.5">
                    <input
                      autoFocus
                      className="min-w-0 flex-1 bg-transparent text-[11px] text-text outline-none placeholder:text-text-faint"
                      placeholder="Card title…"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void addCard(status)
                        if (e.key === 'Escape') {
                          setAddingTo(null)
                          setDraftTitle('')
                        }
                      }}
                      onBlur={() => {
                        if (!draftTitle.trim()) setAddingTo(null)
                      }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 rounded-panel px-2 py-1.5 text-[11px] text-text-faint transition-colors hover:bg-bg-hover hover:text-text"
                    onClick={() => setAddingTo(status)}
                  >
                    <Plus size={12} /> Add card
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
