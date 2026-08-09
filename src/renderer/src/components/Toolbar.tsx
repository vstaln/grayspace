import React from 'react'
import { Eraser, Hand, MessageCircle, MousePointer2, Pencil, Trash2 } from 'lucide-react'
import { CanvasTool, STROKE_COLORS } from '../types'

interface Props {
  tool: CanvasTool
  onToolChange(tool: CanvasTool): void
  hasStrokes: boolean
  onClearStrokes(): void
  onOpenChat(): void
  strokeColor: string
  onStrokeColorChange(color: string): void
}

function ToolButton({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className={`grid h-9 w-9 flex-none place-items-center rounded-full transition-colors duration-150 ${
        active ? 'bg-accent text-black' : 'text-text-dim hover:bg-bg-hover hover:text-text'
      }`}
      onClick={onClick}
      title={label}
      aria-label={label}
      {...(active !== undefined ? { 'aria-pressed': active } : {})}
    >
      {children}
    </button>
  )
}

/** Floating bottom-center pill for switching how a click on the canvas behaves. */
export default function Toolbar({
  tool,
  onToolChange,
  hasStrokes,
  onClearStrokes,
  onOpenChat,
  strokeColor,
  onStrokeColorChange
}: Props): React.JSX.Element {
  return (
    <div className="fixed bottom-8 left-1/2 z-[700] flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-[rgba(18,18,20,0.6)] p-1 shadow-2xl backdrop-blur-2xl backdrop-saturate-150 glass:border-line-soft">
      {/* Only relevant while actually drawing, so it stays out of the way otherwise. */}
      {tool === 'draw' && (
        <div className="absolute bottom-[calc(100%+8px)] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-[rgba(18,18,20,0.6)] px-2.5 py-2 shadow-2xl backdrop-blur-2xl backdrop-saturate-150 glass:border-line-soft">
          {STROKE_COLORS.map((c) => (
            <button
              key={c}
              className={`relative h-5 w-5 flex-none rounded-full border transition-transform duration-100 after:absolute after:-inset-[2px] after:rounded-full after:content-[''] ${
                strokeColor === c ? 'scale-110 border-white' : 'border-white/25 hover:scale-105'
              }`}
              style={{ backgroundColor: c }}
              onClick={() => onStrokeColorChange(c)}
              title={c}
              aria-label={`Цвет ${c}`}
              aria-pressed={strokeColor === c}
            />
          ))}
        </div>
      )}

      <ToolButton label="Курсор" active={tool === 'select'} onClick={() => onToolChange('select')}>
        <MousePointer2 size={16} />
      </ToolButton>
      <ToolButton label="Рука — перетаскивание холста" active={tool === 'pan'} onClick={() => onToolChange('pan')}>
        <Hand size={16} />
      </ToolButton>
      <ToolButton label="Рисование" active={tool === 'draw'} onClick={() => onToolChange('draw')}>
        <Pencil size={16} />
      </ToolButton>
      {/* A tool now, not a one-shot action — pick it, then drag over whatever
          you want gone. Only that touched part disappears. */}
      <ToolButton label="Ластик — проведите по линии" active={tool === 'erase'} onClick={() => onToolChange('erase')}>
        <Eraser size={16} />
      </ToolButton>
      {hasStrokes && (
        <ToolButton label="Стереть весь рисунок" onClick={onClearStrokes}>
          <Trash2 size={16} />
        </ToolButton>
      )}
      <span className="mx-0.5 h-5 w-px flex-none bg-line-soft" />
      <ToolButton label="Чат" onClick={onOpenChat}>
        <MessageCircle size={16} />
      </ToolButton>
    </div>
  )
}
