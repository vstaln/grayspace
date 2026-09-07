import React from 'react'
import { Eraser, MousePointer2, Pencil, Trash2, ZoomIn, ZoomOut, ZoomIn as ZoomReset, Hand } from 'lucide-react'
import { CanvasTool, STROKE_COLORS } from '../types'
import { palette } from '../design'

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
  zoom?: number
  onZoomIn?(): void
  onZoomOut?(): void
  onZoomReset?(): void
  onPanToggle?(): void
}

function ToolButton({
  label,
  testId,
  active,
  disabled,
  onClick,
  children
}: {
  label: string
  testId: string
  active?: boolean
  disabled?: boolean
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`grid h-9 w-9 flex-none place-items-center rounded-full transition-colors duration-150 disabled:cursor-default disabled:opacity-35 ${
        active ? 'bg-accent text-bg' : 'text-text-dim hover:bg-bg-hover hover:text-text'
      }`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-disabled={disabled || undefined}
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
  onStrokeColorChange,
  zoom = 100,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onPanToggle
}: Props): React.JSX.Element {
  const shellStyle = {
    background: palette.graphite
  } as React.CSSProperties

  const [showPalette, setShowPalette] = React.useState(false)
  const paletteHidden = tool !== 'draw' && !showPalette

  const onZoomInHandler = onZoomIn ?? (() => {})
  const onZoomOutHandler = onZoomOut ?? (() => {})
  const onZoomResetHandler = onZoomReset ?? (() => {})
  const onPanToggleHandler = onPanToggle ?? (() => {})

  return (
    <div
      className="fixed bottom-8 left-1/2 z-[300] flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-full border border-line p-1 shadow-2xl glass:border-line-soft"
      style={shellStyle}
      role="toolbar"
      aria-label="Canvas Tools"
      aria-orientation="horizontal"
    >
      <div
        className={`absolute bottom-[calc(100%+8px)] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line px-2.5 py-2 shadow-2xl glass:border-line-soft transition-all ${paletteHidden ? 'pointer-events-none invisible scale-95 opacity-0' : 'scale-100 opacity-100'}`}
        style={shellStyle}
        role="group"
        aria-label="Stroke Color"
        inert={paletteHidden}
        onMouseEnter={() => setShowPalette(true)}
        onMouseLeave={() => setShowPalette(false)}
        onFocus={() => setShowPalette(true)}
        onBlur={() => setShowPalette(false)}
      >
        {STROKE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`relative h-5 w-5 flex-none rounded-full border transition-transform duration-150 after:absolute after:-inset-[2px] after:rounded-full after:content-[''] ${
              strokeColor === c ? 'scale-110 border-white' : 'border-white/25 hover:scale-105'
            }`}
            style={{ backgroundColor: c }}
            onClick={() => {
              onStrokeColorChange(c)
              if (tool !== 'draw') onToolChange('draw')
            }}
            title={STROKE_COLOR_NAMES[c]}
            aria-label={`${STROKE_COLOR_NAMES[c]} color`}
            aria-pressed={strokeColor === c}
          />
        ))}
      </div>

      <ToolButton label="Select" testId="tool-select" active={tool === 'select'} onClick={() => onToolChange('select')}>
        <MousePointer2 size={16} />
      </ToolButton>
      <div
        className="relative"
        onMouseEnter={() => setShowPalette(true)}
        onMouseLeave={(e) => {
          // Palette is absolute outside this div — leaving toward palette would close it, so keep open if entering palette
          const to = e.relatedTarget as HTMLElement | null
          if (to?.closest?.('[role="group"][aria-label="Stroke Color"]')) return
          setShowPalette(false)
        }}
        onFocus={() => setShowPalette(true)}
        onBlur={() => setShowPalette(false)}
      >
        <ToolButton label="Draw" testId="tool-draw" active={tool === 'draw'} onClick={() => onToolChange('draw')}>
          <Pencil size={16} />
        </ToolButton>
      </div>
      {/* A tool now, not a one-shot action — pick it, then drag over whatever
          you want gone. Only that touched part disappears. */}
      <ToolButton label="Eraser — drag over strokes to erase" testId="tool-erase" active={tool === 'erase'} onClick={() => onToolChange('erase')}>
        <Eraser size={16} />
      </ToolButton>
      <ToolButton label="Clear all drawings" testId="tool-clear-strokes" disabled={!hasStrokes} onClick={onClearStrokes}>
        <Trash2 size={16} />
      </ToolButton>

      {/* Pan toggle */}
      <ToolButton label="Pan" testId="tool-pan" active={tool === 'pan'} onClick={() => onToolChange('pan')}>
        <Hand size={16} />
      </ToolButton>

      {/* Zoom controls */}
      <ToolButton label="Zoom out" testId="zoom-out" onClick={onZoomInHandler}>
        <ZoomOut size={16} />
      </ToolButton>
      <ToolButton label="Zoom in" testId="zoom-in" onClick={onZoomOutHandler}>
        <ZoomIn size={16} />
      </ToolButton>
      <ToolButton label="Reset zoom" testId="zoom-reset" onClick={onZoomResetHandler}>
        <ZoomReset size={16} />
      </ToolButton>

      <span className="flex items-center px-1.5 text-[10px] font-mono text-text-faint">
        {Math.round(zoom)}%
      </span>
    </div>
  )
}
