import React from 'react'
import { Eraser, MousePointer2, Pencil, Trash2 } from 'lucide-react'
import { CanvasTool, STROKE_COLORS } from '../types'
import { frost, palette } from '../design'

/** Human names for the swatch tooltips / screen-reader labels (a raw hex code reads terribly). */
const STROKE_COLOR_NAMES: Record<(typeof STROKE_COLORS)[number], string> = {
  '#ffffff': 'White',
  '#ff6b6b': 'Red',
  '#ffa94d': 'Orange',
  '#ffd43b': 'Yellow',
  '#69db7c': 'Green',
  '#4dabf7': 'Blue',
  '#b197fc': 'Violet',
  '#f783ac': 'Pink'
}

interface Props {
  tool: CanvasTool
  onToolChange(tool: CanvasTool): void
  hasStrokes: boolean
  onClearStrokes(): void
  strokeColor: string
  onStrokeColorChange(color: string): void
}

function ToolButton({
  label,
  testId,
  active,
  onClick,
  children
}: {
  label: string
  testId: string
  active?: boolean
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className={`grid h-9 w-9 flex-none place-items-center rounded-full transition-colors duration-150 ${
        active ? 'bg-accent text-bg' : 'text-text-dim hover:bg-bg-hover hover:text-text'
      }`}
      onClick={onClick}
      title={label}
      aria-label={label}
      data-testid={testId}
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
  strokeColor,
  onStrokeColorChange
}: Props): React.JSX.Element {
  const shellStyle = {
    background: palette.graphite,
    backdropFilter: frost.shell,
    WebkitBackdropFilter: frost.shell
  } as React.CSSProperties

  return (
    <div
      className="fixed bottom-8 left-1/2 z-[300] flex -translate-x-1/2 items-center gap-1 rounded-full border border-line p-1 shadow-2xl glass:border-line-soft"
      style={shellStyle}
      role="toolbar"
      aria-label="Canvas Tools"
    >
      {/* Only relevant while actually drawing, so it stays out of the way otherwise. */}
      {tool === 'draw' && (
        <div
          className="absolute bottom-[calc(100%+8px)] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line px-2.5 py-2 shadow-2xl glass:border-line-soft"
          style={shellStyle}
          role="group"
          aria-label="Stroke Color"
        >
          {STROKE_COLORS.map((c) => (
            <button
              key={c}
              className={`relative h-5 w-5 flex-none rounded-full border transition-transform duration-150 after:absolute after:-inset-[2px] after:rounded-full after:content-[''] ${
                strokeColor === c ? 'scale-110 border-white' : 'border-white/25 hover:scale-105'
              }`}
              style={{ backgroundColor: c }}
              onClick={() => onStrokeColorChange(c)}
              title={STROKE_COLOR_NAMES[c]}
              aria-label={`${STROKE_COLOR_NAMES[c]} color`}
              aria-pressed={strokeColor === c}
            />
          ))}
        </div>
      )}

      <ToolButton label="Select" testId="tool-select" active={tool === 'select'} onClick={() => onToolChange('select')}>
        <MousePointer2 size={16} />
      </ToolButton>
      <ToolButton label="Draw" testId="tool-draw" active={tool === 'draw'} onClick={() => onToolChange('draw')}>
        <Pencil size={16} />
      </ToolButton>
      {/* A tool now, not a one-shot action — pick it, then drag over whatever
          you want gone. Only that touched part disappears. */}
      <ToolButton label="Eraser — drag over strokes to erase" testId="tool-erase" active={tool === 'erase'} onClick={() => onToolChange('erase')}>
        <Eraser size={16} />
      </ToolButton>
      {hasStrokes && (
        <ToolButton label="Clear all drawings" testId="tool-clear-strokes" onClick={onClearStrokes}>
          <Trash2 size={16} />
        </ToolButton>
      )}
    </div>
  )
}
