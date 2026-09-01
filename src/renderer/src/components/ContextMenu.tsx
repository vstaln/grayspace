import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clipboard, Cpu, FolderOpen, Globe, ListTodo, Music2, Network, Terminal, Timer } from 'lucide-react'
import { Point } from '../types'

interface Props {
  at: Point
  onPickTerminal: () => void
  onPickFiles: () => void
  onPickSysMonitor: () => void
  onPickTimer: () => void
  onPickPlanner: () => void
  onPickBrowser: () => void
  onPickLinks: () => void
  onPickMusicPlayer: () => void
  onPickOrchestration: () => void
  favoriteWidgets: string[]
  onClose: () => void
}

interface Item {
  /** Stable slug used for the data-testid (E2E locators must not key off localized labels). */
  id: string
  label: string
  hint: string
  icon: React.ReactNode
  onSelect: () => void
  /** `panel` items open over the canvas rather than placing a widget on it. */
  group?: 'widget' | 'panel'
}

export default function ContextMenu({
  at,
  onPickTerminal,
  onPickFiles,
  onPickSysMonitor,
  onPickTimer,
  onPickPlanner,
  onPickBrowser,
  onPickLinks,
  onPickMusicPlayer,
  onPickOrchestration,
  favoriteWidgets,
  onClose
}: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Widgets that land on the canvas first, then the panels that open over it —
  // the divider between the two groups is what keeps the menu scannable.
  const items: Item[] = useMemo(
    () => [
      {
        id: 'terminal',
        label: 'Terminal',
        hint: 'Shell in current workspace',
        icon: <Terminal size={15} className="text-accent" />,
        onSelect: onPickTerminal
      },
      {
        id: 'files',
        label: 'Files',
        hint: 'Browse workspace files and folders',
        icon: <FolderOpen size={15} className="text-accent" />,
        onSelect: onPickFiles
      },
      {
        id: 'sys-monitor',
        label: 'System Monitor',
        hint: 'CPU, RAM & process statistics',
        icon: <Cpu size={15} className="text-accent" />,
        onSelect: onPickSysMonitor
      },
      {
        id: 'timer',
        label: 'Timer',
        hint: 'Countdown or stopwatch for deep work',
        icon: <Timer size={15} className="text-accent" />,
        onSelect: onPickTimer
      },
      {
        id: 'planner',
        label: 'Planner',
        hint: 'Daily agenda checklist and plan',
        icon: <ListTodo size={15} className="text-accent" />,
        onSelect: onPickPlanner
      },
      {
        id: 'browser',
        label: 'Browser',
        hint: 'Embedded web page pinned to the canvas',
        icon: <Globe size={15} className="text-accent" />,
        onSelect: onPickBrowser
      },
      {
        id: 'links',
        label: 'Links',
        hint: 'Save links and copy them in one click',
        icon: <Clipboard size={15} className="text-accent" />,
        onSelect: onPickLinks
      },
      {
        id: 'music-player',
        label: 'Music Player',
        hint: 'Stream YouTube, Yandex, Spotify or MP3 links',
        icon: <Music2 size={15} className="text-accent" />,
        onSelect: onPickMusicPlayer
      },
      {
        id: 'orchestration',
        label: 'Orchestration',
        hint: 'Watch the agent fleet: tasks, workers and their questions',
        icon: <Network size={15} className="text-accent" />,
        onSelect: onPickOrchestration
      }
    ].filter((item) => favoriteWidgets.includes(item.id)),
    [
      onPickTerminal,
      onPickFiles,
      onPickSysMonitor,
      onPickTimer,
      onPickPlanner,
      onPickBrowser,
      onPickLinks,
      onPickMusicPlayer,
      onPickOrchestration,
      favoriteWidgets
    ]
  )

  // Nudge the menu back on-screen once its real size is known.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - rect.height - 4))
    })
  }, [at, items.length])

  useLayoutEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  // Focus the menu immediately so arrow keys work without an extra click.
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Context Menu"
      tabIndex={-1}
      aria-activedescendant={items[selectedIndex] ? `cm-item-${items[selectedIndex].id}` : undefined}
      className="fixed z-[10000] w-[260px] max-w-[calc(100vw-16px)] rounded-[12px] border border-line bg-bg-panel p-2 shadow-2xl glass:bg-bg-panel/90 glass:backdrop-blur-2xl glass:backdrop-saturate-150 select-none"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => {
        // React portals bubble through the component tree: without this,
        // pointerdown reaches <main> and draw/erase/pan gestures fire from
        // clicks inside the menu (mousedown alone cannot stop it — it fires
        // after pointerdown).
        e.stopPropagation()
      }}
      onMouseDown={(e) => {
        // Prevent pan / stroke triggers on canvas below
        e.stopPropagation()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (items.length) setSelectedIndex((prev) => (prev + 1) % items.length)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (items.length) setSelectedIndex((prev) => (prev - 1 + items.length) % items.length)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          items[selectedIndex]?.onSelect()
        }
      }}
    >
      <div className="px-2 pt-1 pb-2 text-[10px] font-semibold tracking-wider text-text-faint uppercase">
        Add to Canvas
      </div>

      {/* Items List */}
      <div className="max-h-[360px] space-y-0.5 overflow-y-auto">
        {items.length === 0 && <div className="px-2.5 py-3 text-[11px] text-text-faint">No favorite widgets selected. Choose them in Settings.</div>}
        {items.map((item, i) => {
          const isSelected = i === selectedIndex
          const isPanelGroupStart = item.group === 'panel' && items[i - 1]?.group !== 'panel'

          return (
            <div
              key={item.id}
              id={`cm-item-${item.id}`}
              role="menuitem"
              tabIndex={-1}
              data-testid={`cm-${item.id}`}
              aria-label={`${item.label} — ${item.hint}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={item.onSelect}
              className={`group flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 transition-colors duration-100 ${
                isSelected ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover hover:text-text'
              } ${isPanelGroupStart ? 'mt-1.5 border-t border-line-soft pt-2' : ''}`}
            >
              <div className="flex-none transition-transform duration-100 group-hover:scale-110">
                {item.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-xs ${isSelected ? 'font-medium text-text' : 'text-text'}`}>
                  {item.label}
                </div>
                <div className="truncate text-[10px] text-text-faint">{item.hint}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>,
    document.body
  )
}
