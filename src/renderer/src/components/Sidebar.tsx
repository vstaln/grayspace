import React, { useEffect, useRef, useState } from 'react'
import { Brain, Check, FileText, FolderOpen, Image, KanbanSquare, Pin, Plus, Settings, ShieldCheck, Trash2, X } from 'lucide-react'
import type { RecentDir } from '../../../preload/index.d'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { THEMES, useTheme } from '../theme'

interface Props {
  workspaceDir: string | null
  managerId: string | null
  boardOpen: boolean
  brainOpen: boolean
  graphOpen: boolean
  taskCount: number
  onNewTerminal(): void
  onToggleBoard(): void
  onToggleBrain(): void
  onToggleGraph(): void
  onPickDir(): void
  onResetManager(): void
}

function IconButton({
  label,
  active,
  danger,
  badge,
  onClick,
  children
}: {
  label: string
  active?: boolean
  danger?: boolean
  badge?: number
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={[
        'group relative grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-transparent text-text-dim transition-colors duration-150',
        active
          ? 'rail-btn-active'
          : danger
            ? 'hover:bg-danger/15 hover:text-danger'
            : 'hover:bg-bg-hover hover:text-text'
      ].join(' ')}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
      {badge ? (
        <span className="absolute top-0.5 right-0.5 min-w-[15px] rounded-full bg-accent px-1 text-[9px] leading-[15px] font-semibold text-black">
          {badge}
        </span>
      ) : null}
      <span className="pointer-events-none absolute left-[calc(100%+10px)] z-[900] max-w-80 overflow-hidden rounded-[10px] border border-line bg-bg-panel px-2.5 py-1.5 text-[11px] text-ellipsis whitespace-nowrap text-text opacity-0 transition-all duration-150 -translate-x-1 group-hover:translate-x-0 group-hover:opacity-100">
        {label}
      </span>
    </button>
  )
}

/** Theme/background/dim settings, opened from the rail next to the manager indicator. */
function SettingsButton(): React.JSX.Element {
  const { theme, setTheme, background, dim, setDim, pickBackground, clearBackground, error } = useTheme()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useFocusTrap(menuRef, open)

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

  return (
    <div className="relative" ref={rootRef}>
      <IconButton label="Настройки темы" onClick={() => setOpen((v) => !v)}>
        <Settings size={17} />
      </IconButton>
      {open && (
        <div
          ref={menuRef}
          role="dialog"
          aria-modal="true"
          aria-label="Настройки темы"
          className="absolute bottom-0 left-[calc(100%+10px)] z-[10000] w-64 rounded-[10px] border border-line bg-bg-panel p-1.5 shadow-2xl glass:bg-bg-panel/85 glass:backdrop-blur-2xl"
        >
          <div className="px-2.5 pt-1.5 pb-2 text-[10px] tracking-wider text-text-faint uppercase">Тема оформления</div>
          {THEMES.map((t) => (
            <button
              key={t.id}
              className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left hover:bg-bg-hover"
              onClick={() => setTheme(t.id)}
            >
              <span className="w-3 flex-none text-xs text-accent">{theme === t.id && <Check size={13} />}</span>
              <span>
                <span className={`block text-xs ${theme === t.id ? 'text-accent' : 'text-text'}`}>{t.label}</span>
                <span className="mt-0.5 block text-[10px] text-text-faint">{t.hint}</span>
              </span>
            </button>
          ))}

          {theme === 'photo' && (
            <div className="mt-1.5 border-t border-line-soft pt-2">
              {background ? (
                <div
                  className="mx-1 h-16 rounded-[10px] border border-line-soft bg-cover bg-center"
                  style={{ backgroundImage: `url("${background}")` }}
                />
              ) : (
                <p className="mx-1 rounded-[10px] border border-dashed border-line-soft px-2 py-3 text-center text-[10px] text-text-faint">
                  Фон не выбран
                </p>
              )}

              <div className="mt-1.5 flex gap-1 px-1">
                <button
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-line px-2 py-1.5 text-[11px] text-text hover:bg-bg-hover"
                  onClick={() => void pickBackground()}
                >
                  <Image size={12} />
                  {background ? 'Заменить' : 'Выбрать фото'}
                </button>
                {background && (
                  <button
                    className="grid w-8 flex-none place-items-center rounded-[10px] border border-line text-text-dim hover:bg-bg-hover hover:text-danger"
                    title="Убрать фон"
                    aria-label="Убрать фон"
                    onClick={clearBackground}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              <label className="mt-2.5 block px-1">
                <span className="flex items-center justify-between text-[10px] tracking-wider text-text-faint uppercase">
                  Затемнение
                  <span className="tracking-normal normal-case">{dim}%</span>
                </span>
                <input
                  className="mt-1.5 w-full accent-white"
                  type="range"
                  min={0}
                  max={90}
                  step={5}
                  value={dim}
                  onChange={(e) => setDim(Number(e.target.value))}
                />
              </label>

              {error && <p className="mt-2 px-1 text-[10px] text-danger">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({
  workspaceDir,
  managerId,
  boardOpen,
  brainOpen,
  graphOpen,
  taskCount,
  onNewTerminal,
  onToggleBoard,
  onToggleBrain,
  onToggleGraph,
  onPickDir,
  onResetManager
}: Props): React.JSX.Element {
  const [recent, setRecent] = useState<RecentDir[]>([])
  const [foldersOpen, setFoldersOpen] = useState(false)
  const foldersRef = useRef<HTMLDivElement>(null)
  const foldersMenuRef = useRef<HTMLDivElement>(null)
  useFocusTrap(foldersMenuRef, foldersOpen)
  const dirName = workspaceDir ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() : null

  // Remembered folders live in the main process, so mirror them live.
  useEffect(() => {
    void window.api.workspace.recent().then(setRecent)
    return window.api.workspace.onRecentChange(setRecent)
  }, [])

  useEffect(() => {
    if (!foldersOpen) return
    const onDown = (e: MouseEvent): void => {
      if (foldersRef.current && !foldersRef.current.contains(e.target as Node)) setFoldersOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFoldersOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [foldersOpen])

  const open = async (path: string): Promise<void> => {
    await window.api.workspace.openRecent(path)
    setFoldersOpen(false)
  }

  const RAIL_ITEM_IDS = ['new', 'board', 'notes', 'graph', 'folders'] as const
  type RailItemId = (typeof RAIL_ITEM_IDS)[number]
  const [order, setOrder] = useState<RailItemId[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('rail-order') || 'null') as RailItemId[] | null
      if (saved && RAIL_ITEM_IDS.every((id) => saved.includes(id))) return saved
    } catch {
      // ignore malformed storage
    }
    return [...RAIL_ITEM_IDS]
  })
  const dragIdRef = useRef<RailItemId | null>(null)

  const reorder = (target: RailItemId): void => {
    const dragged = dragIdRef.current
    if (!dragged || dragged === target) return
    setOrder((prev) => {
      const next = prev.filter((id) => id !== dragged)
      next.splice(next.indexOf(target), 0, dragged)
      localStorage.setItem('rail-order', JSON.stringify(next))
      return next
    })
  }

  const railItems: Record<RailItemId, React.ReactNode> = {
    new: (
      <IconButton label="Новый терминал" onClick={onNewTerminal}>
        <Plus size={19} />
      </IconButton>
    ),
    board: (
      <IconButton label="Доска задач" active={boardOpen} badge={taskCount} onClick={onToggleBoard}>
        <KanbanSquare size={17} />
      </IconButton>
    ),
    notes: (
      <IconButton label="Notes" active={brainOpen} onClick={onToggleBrain}>
        <FileText size={17} />
      </IconButton>
    ),
    graph: (
      <IconButton label="Graph" active={graphOpen} onClick={onToggleGraph}>
        <Brain size={17} />
      </IconButton>
    ),
    folders: (
      <div className="relative" ref={foldersRef}>
        <IconButton
          label={workspaceDir ? `Папки · сейчас: ${dirName}` : 'Рабочие папки'}
          active={Boolean(workspaceDir)}
          onClick={() => setFoldersOpen((v) => !v)}
        >
          <FolderOpen size={17} />
        </IconButton>

        {foldersOpen && (
          <div
            ref={foldersMenuRef}
            role="dialog"
            aria-modal="true"
            aria-label="Рабочие папки"
            className="absolute top-0 left-[calc(100%+10px)] z-[900] w-72 rounded-[10px] border border-line bg-bg-panel p-2 shadow-2xl glass:bg-bg-panel/85 glass:backdrop-blur-2xl"
          >
            <div className="px-1.5 pt-1 pb-2 text-[10px] tracking-wider text-text-faint uppercase">Рабочие папки</div>
            <div className="flex max-h-72 flex-col gap-1 overflow-auto">
              {recent.map((entry) => (
                <div
                  key={entry.path}
                  className={`group flex items-center gap-1 rounded-[10px] ${entry.path === workspaceDir ? 'bg-bg-hover' : ''}`}
                  title={entry.path}
                >
                  <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => void open(entry.path)}>
                    <b className="block truncate text-xs font-semibold text-text">{entry.name}</b>
                    <span className="block truncate text-[10px] text-text-faint">{entry.path}</span>
                  </button>
                  <button
                    className={`flex-none rounded-[10px] p-1 text-text-faint hover:bg-bg-hover hover:text-text ${entry.pinned ? 'text-accent' : ''}`}
                    title={entry.pinned ? 'Открепить' : 'Закрепить'}
                    onClick={() => void window.api.workspace.pinRecent(entry.path)}
                  >
                    <Pin size={12} />
                  </button>
                  <button
                    className="flex-none rounded-[10px] p-1 text-text-faint hover:bg-bg-hover hover:text-text"
                    title="Убрать из списка"
                    onClick={() => void window.api.workspace.forgetRecent(entry.path)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {!recent.length && (
                <div className="px-2 py-3 text-center text-[11px] text-text-faint">Список пуст — выберите первую папку</div>
              )}
            </div>
            <button
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-[10px] bg-accent px-3 py-2 text-xs font-semibold text-black hover:bg-white"
              onClick={() => {
                onPickDir()
                setFoldersOpen(false)
              }}
            >
              <FolderOpen size={14} /> Выбрать папку…
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <aside
      className="rail-shell rail relative z-[500] flex w-14 flex-none flex-col items-center gap-1.5 border-r border-line pt-8 pb-2.5 glass:border-line-soft select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex-1" />
      <div className="flex flex-col gap-1.5">
        {order.map((id) => (
          <div
            key={id}
            draggable
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onDragStart={() => {
              dragIdRef.current = id
            }}
            onDragOver={(e) => {
              e.preventDefault()
              reorder(id)
            }}
            onDragEnd={() => {
              dragIdRef.current = null
            }}
            className="cursor-grab active:cursor-grabbing"
          >
            {railItems[id]}
          </div>
        ))}
      </div>

      <div className="flex-1" />
      <div className="flex flex-col gap-1.5">
        <SettingsButton />
        <IconButton
          label={managerId ? `Сбросить руководителя (${managerId})` : 'Руководитель не назначен'}
          danger={Boolean(managerId)}
          onClick={onResetManager}
        >
          <ShieldCheck size={17} />
        </IconButton>
      </div>
      <div className="grid h-4 place-items-center" title={managerId || 'нет руководителя'}>
        <span className={`h-[7px] w-[7px] rounded-full ${managerId ? 'bg-ok shadow-[0_0_8px_rgba(111,211,154,0.7)]' : 'bg-text-faint'}`} />
      </div>
      {dirName && (
        <div className="max-w-full truncate px-1 text-center text-[8px] text-text-faint" title={workspaceDir || ''}>
          {dirName}
        </div>
      )}
    </aside>
  )
}
