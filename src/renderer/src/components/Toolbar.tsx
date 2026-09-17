import React from 'react'
import { Eraser, Expand, FolderOpen, Hand, MoreHorizontal, MousePointer2, Pencil, Settings, Trash2 } from 'lucide-react'
import { CanvasTool, STROKE_COLORS } from '../types'
import { CommandPrefix, parseWidgetInvocation } from '../lib/commandInput'
import { WIDGET_CATALOG } from '../lib/widgetCatalog'

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
  workspaceDir: string | null
  onPickDir(): void
  terminals: { id: string; title: string }[]
  targetTerminalId?: string | null
  commandPrefix: CommandPrefix
  onTargetTerminalChange(id: string): void
  onCreateWidget(kind: import('../types').WidgetKind, initialCommand: string): void
  onSubmitCommand(id: string, command: string, mode: 'command' | 'message'): void
  zoom?: number
  onZoomIn?(): void
  onZoomOut?(): void
  onResetZoom?(): void
  onFitView?(): void
}

function ToolButton({ label, testId, active, disabled, onClick, children }: {
  label: string; testId: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode
}): React.JSX.Element {
  return <button type="button" disabled={disabled} className={`grid h-8 w-8 flex-none place-items-center rounded-panel transition-colors duration-150 disabled:cursor-default disabled:opacity-35 ${active ? 'bg-bg-hover text-text' : 'text-text hover:bg-bg-hover'}`} onClick={onClick} title={label} aria-label={label} aria-disabled={disabled || undefined} data-testid={testId} {...(active !== undefined ? { 'aria-pressed': active } : {})}>{children}</button>
}

export default function Toolbar({ tool, onToolChange, hasStrokes, onClearStrokes, strokeColor, onStrokeColorChange, workspaceDir, onPickDir, terminals, targetTerminalId = '', commandPrefix, onTargetTerminalChange, onCreateWidget, onSubmitCommand, zoom, onZoomIn, onZoomOut, onResetZoom, onFitView }: Props): React.JSX.Element {
  const [showPalette, setShowPalette] = React.useState(false)
  const [showOverflow, setShowOverflow] = React.useState(false)
  const [command, setCommand] = React.useState('')
  const [mode, setMode] = React.useState<'command' | 'message'>('command')
  const [suggestionIndex, setSuggestionIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const overflowTriggerRef = React.useRef<HTMLButtonElement>(null)
  const overflowRef = React.useRef<HTMLDivElement>(null)
  const overflowMenuRef = React.useRef<HTMLDivElement>(null)
  const paletteHidden = tool !== 'draw' && !showPalette
  const dirName = workspaceDir?.split(/[\\/]/).filter(Boolean).pop() || 'No folder'
  const configuredTerminalId = targetTerminalId ?? ''
  const activeTerminalId = terminals.some((terminal) => terminal.id === configuredTerminalId) ? configuredTerminalId : terminals[0]?.id || ''
  const suggestionQuery = command.trimStart().split(/\s+/, 1)[0]?.toLowerCase() || ''
  const suggestions = React.useMemo(() => {
    if (mode !== 'command' || !suggestionQuery || command.trim().includes(' ')) return []
    const typedPrefix = /^[/.@]/.test(suggestionQuery) ? suggestionQuery[0] : ''
    if (typedPrefix && commandPrefix !== 'any' && typedPrefix !== commandPrefix) return []
    const query = typedPrefix ? suggestionQuery.slice(1) : suggestionQuery
    return WIDGET_CATALOG.filter(({ kind }) => kind.startsWith(query) || kind.replace('-', '').startsWith(query.replace('-', '')))
  }, [command, mode, suggestionQuery, commandPrefix])
  React.useEffect(() => setSuggestionIndex(0), [suggestionQuery, mode, commandPrefix])
  React.useEffect(() => {
    if (suggestionIndex >= suggestions.length) setSuggestionIndex(0)
  }, [suggestions.length, suggestionIndex])
  React.useEffect(() => {
    if (!showOverflow) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!overflowRef.current?.contains(event.target as Node)) setShowOverflow(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setShowOverflow(false)
        overflowTriggerRef.current?.focus()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [showOverflow])

  React.useLayoutEffect(() => {
    if (!showOverflow) return
    const first = overflowMenuRef.current?.querySelector<HTMLElement>('button:not([disabled]), select, [tabindex]:not([tabindex="-1"])')
    first?.focus()
  }, [showOverflow])

  const closeOverflow = (restoreFocus = false): void => {
    setShowOverflow(false)
    if (restoreFocus) overflowTriggerRef.current?.focus()
  }

  const canSubmit = Boolean(command.trim()) && Boolean(activeTerminalId || (mode === 'command' && parseWidgetInvocation(command.trim(), commandPrefix)))

  const submitCommand = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const value = command.trim()
    if (!value) return
    if (suggestions.length > 0) {
      const picked = suggestions[Math.min(suggestionIndex, suggestions.length - 1)].kind
      const typedName = suggestionQuery.replace(/^[/.@]/, '').toLowerCase()
      if (typedName !== picked.toLowerCase()) {
        chooseSuggestion(picked)
        return
      }
    }
    if (mode === 'command') {
      const widget = parseWidgetInvocation(value, commandPrefix)
      if (widget) {
        onCreateWidget(widget.kind, widget.initialCommand)
        setCommand('')
        return
      }
    }
    if (!activeTerminalId) return
    onSubmitCommand(activeTerminalId, value, mode)
    setCommand('')
  }

  const openSettings = (): void => {
    window.dispatchEvent(new Event('orcspace:open-settings'))
  }

  const chooseSuggestion = (name: string): void => {
    const typedPrefix = /^[/.@]/.test(suggestionQuery) ? suggestionQuery[0] : ''
    const prefix = typedPrefix || (commandPrefix === 'any' ? '/' : commandPrefix)
    setCommand(`${prefix}${name} `)
    inputRef.current?.focus()
  }

  const shellStyle = {
    background: `rgba(18, 18, 18, 0.80)`,
    backdropFilter: 'blur(20px) brightness(0.94)',
    WebkitBackdropFilter: 'blur(20px) brightness(0.94)'
  } as React.CSSProperties
  return <div className="fixed bottom-6 left-1/2 z-[300] flex h-12 w-[min(780px,calc(100vw-24px))] max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 rounded-panel border border-line px-2 py-1 shadow-2xl glass:border-line-soft" style={shellStyle} role="toolbar" aria-label="Canvas Tools" aria-orientation="horizontal">
    {suggestions.length > 0 && (
      <div
        className="absolute bottom-[calc(100%+8px)] left-10 z-[320] min-w-[250px] overflow-hidden rounded-panel border border-line bg-bg-panel/95 p-1 shadow-2xl backdrop-blur-md"
        role="listbox"
        id="command-suggestions"
        aria-label="Command suggestions"
        data-canvas-interactive="true"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {suggestions.map(({ kind: name, label, hint }, index) => (
          <div
            key={name}
            role="option"
            id={`command-suggestion-${index}`}
            aria-selected={index === Math.min(suggestionIndex, suggestions.length - 1)}
            data-testid={`command-suggestion-${name}`}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-panel px-2.5 py-2 text-left text-[11px] ${index === Math.min(suggestionIndex, suggestions.length - 1) ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover hover:text-text'}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => chooseSuggestion(name)}
          >
            <span className="font-mono text-accent">{/^[/.@]/.test(suggestionQuery) ? suggestionQuery[0] : commandPrefix === 'any' ? '/' : commandPrefix}{name}</span>
            <span className="ml-auto text-[10px] text-text-faint">{label} · {hint}</span>
          </div>
        ))}
      </div>
    )}
    <div className={`absolute bottom-[calc(100%+8px)] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-panel border border-line bg-bg-raise/90 px-2.5 py-2 shadow-2xl backdrop-blur-[20px] transition-all glass:border-line-soft ${paletteHidden ? 'pointer-events-none invisible scale-95 opacity-0' : 'scale-100 opacity-100'}`} role="group" aria-label="Stroke Color" inert={paletteHidden ? true : undefined} aria-hidden={paletteHidden || undefined} onMouseEnter={() => setShowPalette(true)} onMouseLeave={() => setShowPalette(false)} onFocus={() => setShowPalette(true)} onBlur={() => setShowPalette(false)}>
      {STROKE_COLORS.map((c) => <button key={c} type="button" className={`relative h-5 w-5 flex-none rounded-pill border transition-transform duration-150 after:absolute after:-inset-[2px] after:rounded-pill after:content-[''] ${strokeColor === c ? 'scale-110 border-accent' : 'border-line hover:scale-105'}`} style={{ backgroundColor: c }} onClick={() => { onStrokeColorChange(c); if (tool !== 'draw') onToolChange('draw') }} title={STROKE_COLOR_NAMES[c]} aria-label={STROKE_COLOR_NAMES[c]} aria-pressed={strokeColor === c} />)}
    </div>
    <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={submitCommand}>
      <div className="relative" onMouseEnter={() => setShowPalette(true)} onMouseLeave={(e) => { const to = e.relatedTarget as HTMLElement | null; if (!to?.closest?.('[role="group"][aria-label="Stroke Color"]')) setShowPalette(false) }} onFocus={() => setShowPalette(true)} onBlur={() => setShowPalette(false)}>
      <ToolButton label="Draw" testId="tool-draw" active={tool === 'draw'} onClick={() => onToolChange('draw')}><Pencil size={16} /></ToolButton>
      </div>
      <input ref={inputRef} data-testid="canvas-command-input" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setCommand('')
          inputRef.current?.blur()
          return
        }
        if (suggestions.length === 0) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSuggestionIndex((index) => (index + 1) % suggestions.length)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
        } else if (event.key === 'Tab') {
          event.preventDefault()
          const picked = suggestions[Math.min(suggestionIndex, suggestions.length - 1)]
          if (picked) chooseSuggestion(picked.kind)
        }
      }} className="min-w-0 flex-1 bg-transparent px-1 text-[11px] text-text outline-none placeholder:text-text-faint" placeholder={mode === 'message' ? 'Write a message…' : `Run a command or ${commandPrefix === 'any' ? '/terminal' : `${commandPrefix}terminal`}`} aria-label="Command input" role="combobox" aria-expanded={suggestions.length > 0} aria-controls={suggestions.length > 0 ? 'command-suggestions' : undefined} aria-activedescendant={suggestions.length > 0 ? `command-suggestion-${Math.min(suggestionIndex, suggestions.length - 1)}` : undefined} autoComplete="off" />
      <button type="submit" className="grid h-7 w-7 flex-none place-items-center rounded-pill text-text hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-30" disabled={!canSubmit} aria-label={mode === 'message' ? 'Send message' : 'Run command'} title={mode === 'message' ? 'Send message' : 'Run command'}>↵</button>
    </form>
    <ToolButton label="Select" testId="tool-select" active={tool === 'select'} onClick={() => onToolChange('select')}><MousePointer2 size={15} /></ToolButton>
    <ToolButton label="Eraser — drag over strokes to erase" testId="tool-erase" active={tool === 'erase'} onClick={() => onToolChange('erase')}><Eraser size={16} /></ToolButton>
    <ToolButton label="Pan" testId="tool-pan" active={tool === 'pan'} onClick={() => onToolChange('pan')}><Hand size={16} /></ToolButton>
    <div ref={overflowRef} className="relative flex-none">
      <button
        type="button"
        ref={overflowTriggerRef}
        data-testid="toolbar-more"
        className={`grid h-8 w-8 place-items-center rounded-pill text-text transition-colors ${showOverflow ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`}
        onClick={() => setShowOverflow((open) => !open)}
        aria-label="More toolbar actions"
        aria-haspopup="menu"
        aria-expanded={showOverflow}
        title="More actions"
      >
        <MoreHorizontal size={16} />
      </button>
      {showOverflow && (
        <div
          ref={overflowMenuRef}
          data-testid="toolbar-overflow-menu"
          role="menu"
          tabIndex={-1}
          aria-label="More toolbar actions"
          className="absolute right-0 bottom-[calc(100%+8px)] z-[320] flex w-[min(280px,calc(100vw-24px))] flex-col gap-2 rounded-panel border border-line bg-bg-panel/95 p-2.5 shadow-2xl backdrop-blur-md"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closeOverflow(true)
              return
            }
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target === event.currentTarget) {
              event.preventDefault()
              const focusables = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), select, [tabindex]:not([tabindex="-1"])'))
              if (focusables.length === 0) return
              const current = focusables.indexOf(document.activeElement as HTMLElement)
              const delta = event.key === 'ArrowDown' ? 1 : -1
              focusables[(current + delta + focusables.length) % focusables.length]?.focus()
            }
          }}
        >
          <div className="px-1 text-[10px] font-semibold tracking-wider text-text-faint uppercase">Workspace</div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              role="menuitem"
              className="flex h-8 min-w-0 items-center gap-2 rounded-panel px-2 text-left text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
              onClick={() => { onPickDir(); closeOverflow() }}
              aria-label="Change directory"
            >
              <FolderOpen size={14} className="flex-none" />
              <span className="truncate">{dirName}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex h-8 items-center gap-2 rounded-panel px-2 text-left text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
              onClick={() => { openSettings(); closeOverflow() }}
              aria-label="Settings"
            >
              <Settings size={14} className="flex-none" />
              <span>Settings</span>
            </button>
          </div>

          <div className="h-px bg-line-soft" aria-hidden="true" />
          <div className="px-1 text-[10px] font-semibold tracking-wider text-text-faint uppercase">Command target</div>
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex min-w-0 flex-col gap-1 rounded-panel bg-bg-raise px-2 py-1.5 text-[10px] text-text-faint">
              Mode
              <select data-testid="command-mode" value={mode} onChange={(event) => setMode(event.target.value as 'command' | 'message')} className="h-6 min-w-0 bg-transparent text-[11px] text-text outline-none" aria-label="Command mode">
                <option value="command">Command</option>
                <option value="message">Message</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 rounded-panel bg-bg-raise px-2 py-1.5 text-[10px] text-text-faint">
              Terminal
              <select value={activeTerminalId} onChange={(event) => onTargetTerminalChange(event.target.value)} disabled={!terminals.length} className="h-6 min-w-0 bg-transparent text-[11px] text-text outline-none" aria-label="Target terminal">
                {terminals.length ? terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.title || 'Terminal'}</option>) : <option value="">No terminal</option>}
              </select>
            </label>
          </div>

          {zoom !== undefined && (
            <div className="flex items-center justify-between rounded-panel bg-bg-raise px-2 py-1" role="group" aria-label="Zoom controls">
              <span className="text-[10px] text-text-faint">Canvas zoom</span>
              <div className="flex items-center gap-0.5">
                <button type="button" className="grid h-7 w-7 place-items-center rounded-panel text-text-dim transition-colors hover:bg-bg-hover hover:text-text" onClick={() => onFitView?.()} title="Fit all widgets into view (F)" aria-label="Fit all widgets into view" aria-keyshortcuts="f" data-testid="zoom-fit"><Expand size={14} /></button>
                <button type="button" className="grid h-7 w-7 place-items-center rounded-panel text-[12px] font-semibold text-text-dim transition-colors hover:bg-bg-hover hover:text-text" onClick={onZoomOut} title="Zoom out (-)" aria-label="Zoom out" data-testid="zoom-out">−</button>
                <button type="button" className="h-7 min-w-[42px] rounded-panel px-1 font-mono text-[10px] font-medium text-text-dim transition-colors hover:bg-bg-hover hover:text-text" onClick={onResetZoom} title="Reset zoom to 100% (0; Home resets the view)" aria-label="Reset zoom to 100% (0)" aria-keyshortcuts="0" data-testid="zoom-reset">{Math.round(zoom * 100)}%</button>
                <button type="button" className="grid h-7 w-7 place-items-center rounded-panel text-[12px] font-semibold text-text-dim transition-colors hover:bg-bg-hover hover:text-text" onClick={onZoomIn} title="Zoom in (+)" aria-label="Zoom in" data-testid="zoom-in">+</button>
              </div>
            </div>
          )}

          <button
            type="button"
            role="menuitem"
            disabled={!hasStrokes}
            className="flex h-8 items-center gap-2 rounded-panel px-2 text-left text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => { onClearStrokes(); closeOverflow() }}
            aria-label="Clear all drawings"
            data-testid="tool-clear-strokes"
          >
            <Trash2 size={14} className="flex-none" />
            <span>Clear all drawings</span>
          </button>
        </div>
      )}
    </div>
  </div>
}
