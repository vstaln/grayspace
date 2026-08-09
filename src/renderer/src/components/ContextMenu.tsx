import React, { useLayoutEffect, useRef, useState } from 'react'
import { Point } from '../types'

interface Props {
  at: Point
  onPickTerminal: () => void
  onPickNote: () => void
  onOpenBoard: () => void
  onClose: () => void
}

interface Item {
  label: string
  hint: string
  onSelect: () => void
}

export default function ContextMenu({
  at,
  onPickTerminal, onPickNote,
  onOpenBoard,
  onClose
}: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)

  const items: Item[] = [
    { label: 'Терминал', hint: 'Оболочка в рабочей папке', onSelect: onPickTerminal },
    { label: 'Заметка', hint: 'Мысль или фрагмент знаний на холсте', onSelect: onPickNote },
    { label: 'Доска задач', hint: 'Задачи для вас и агентов', onSelect: onOpenBoard }
  ]

  // Nudge the menu back on-screen once its real size is known.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - rect.height - 4))
    })
  }, [at])

  useLayoutEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  // P3-216: land focus on the first item so arrow keys work immediately.
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])

  const focusItemAt = (index: number): void => {
    const el = ref.current
    if (!el) return
    const nodes = el.querySelectorAll<HTMLElement>('[role="menuitem"]')
    if (index < 0) index = nodes.length - 1
    nodes[index % nodes.length]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusItemAt(index + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusItemAt(index - 1)
        break
      case 'Home':
        e.preventDefault()
        focusItemAt(0)
        break
      case 'End':
        e.preventDefault()
        focusItemAt(items.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        items[index].onSelect()
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        onClose()
        break
      case 'Tab':
        e.preventDefault()
        onClose()
        break
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Контекстное меню"
      className="fixed z-[10000] min-w-[230px] rounded-[10px] border border-line bg-bg-panel p-1.5 shadow-2xl glass:bg-bg-panel/85 glass:backdrop-blur-2xl glass:backdrop-saturate-150"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="px-2.5 pt-1.5 pb-2 text-[10px] tracking-wider text-text-faint uppercase">Добавить</div>
      {items.map((item, i) => (
        <div
          key={item.label}
          role="menuitem"
          tabIndex={-1}
          className="cursor-pointer rounded-[10px] px-2.5 py-1.5 hover:bg-bg-hover focus:bg-bg-hover"
          onClick={item.onSelect}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <div className="text-xs text-text">{item.label}</div>
          <div className="mt-0.5 text-[10px] text-text-faint">{item.hint}</div>
        </div>
      ))}
    </div>
  )
}
