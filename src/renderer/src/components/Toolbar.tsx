import React from 'react'
import { Eraser, FolderOpen, Hand, MousePointer2, Pencil, Settings, Trash2 } from 'lucide-react'
import { CanvasTool, STROKE_COLORS } from '../types'
import { CommandPrefix, parseWidgetInvocation } from '../lib/commandInput'

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

const COMMAND_ITEMS = [
  ['terminal', 'Terminal', 'Open a shell'],
  ['files', 'Files', 'Browse workspace files'],
  ['sys-monitor', 'System Monitor', 'Show CPU and memory'],
  ['timer', 'Timer', 'Start a timer'],
  ['planner', 'Planner', 'Open your checklist'],
  ['orchestration', 'Orchestration', 'Open agent coordination'],
  ['chat', 'AI Chat', 'Chat with an authenticated model'],
  ['browser', 'Browser', 'Open a web page'],
  ['links', 'Links', 'Open saved links'],
  ['music-player', 'Music Player', 'Open the music player']
] as const

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
}

function ToolButton({ label, testId, active, disabled, onClick, children }: {
  label: string; testId: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode
}): React.JSX.Element {
  return <button type="button" disabled={disabled} className={`grid h-8 w-8 flex-none place-items-center rounded-[9px] transition-colors duration-150 disabled:cursor-default disabled:opacity-35 ${active ? 'bg-bg-hover text-text' : 'text-text hover:bg-bg-hover'}`} onClick={onClick} title={label} aria-label={label} aria-disabled={disabled || undefined} data-testid={testId} {...(active !== undefined ? { 'aria-pressed': active } : {})}>{children}</button>
}

export default function Toolbar({ tool, onToolChange, hasStrokes, onClearStrokes, strokeColor, onStrokeColorChange, workspaceDir, onPickDir, terminals, targetTerminalId = '', commandPrefix, onTargetTerminalChange, onCreateWidget, onSubmitCommand }: Props): React.JSX.Element {
  const [showPalette, setShowPalette] = React.useState(false)
  const [command, setCommand] = React.useState('')
  const [mode, setMode] = React.useState<'command' | 'message'>('command')
  const [suggestionIndex, setSuggestionIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
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
    return COMMAND_ITEMS.filter(([name]) => name.startsWith(query) || name.replace('-', '').startsWith(query.replace('-', '')))
  }, [command, mode, suggestionQuery, commandPrefix])
  React.useEffect(() => setSuggestionIndex(0), [suggestionQuery, mode, commandPrefix])
  React.useEffect(() => {
    if (suggestionIndex >= suggestions.length) setSuggestionIndex(0)
  }, [suggestions.length, suggestionIndex])

  const canSubmit = Boolean(command.trim()) && Boolean(activeTerminalId || (mode === 'command' && parseWidgetInvocation(command.trim(), commandPrefix)))

  const submitCommand = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const value = command.trim()
    if (!value) return
    if (suggestions.length > 0) {
      const picked = suggestions[Math.min(suggestionIndex, suggestions.length - 1)][0]
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
  return <div className="fixed bottom-6 left-1/2 z-[300] flex h-12 w-[min(720px,calc(100vw-24px))] max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 rounded-[14px] border border-line px-2 py-1 shadow-2xl glass:border-line-soft" style={shellStyle} role="toolbar" aria-label="Canvas Tools" aria-orientation="horizontal">
    {suggestions.length > 0 && (
      <div
        className="absolute bottom-[calc(100%+8px)] left-10 z-[320] min-w-[250px] overflow-hidden rounded-[10px] border border-line bg-bg-panel/95 p-1 shadow-2xl backdrop-blur-md"
        role="listbox"
        id="command-suggestions"
        aria-label="Command suggestions"
        data-canvas-interactive="true"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {suggestions.map(([name, label, hint], index) => (
          <div
            key={name}
            role="option"
            id={`command-suggestion-${index}`}
            aria-selected={index === Math.min(suggestionIndex, suggestions.length - 1)}
            data-testid={`command-suggestion-${name}`}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[11px] ${index === Math.min(suggestionIndex, suggestions.length - 1) ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover hover:text-text'}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => chooseSuggestion(name)}
          >
            <span className="font-mono text-accent">{/^[/.@]/.test(suggestionQuery) ? suggestionQuery[0] : commandPrefix === 'any' ? '/' : commandPrefix}{name}</span>
            <span className="ml-auto text-[10px] text-text-faint">{label} · {hint}</span>
          </div>
        ))}
      </div>
    )}
    <div className={`absolute bottom-[calc(100%+8px)] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-[12px] border border-line bg-bg-raise/90 px-2.5 py-2 shadow-2xl backdrop-blur-[20px] transition-all glass:border-line-soft ${paletteHidden ? 'pointer-events-none invisible scale-95 opacity-0' : 'scale-100 opacity-100'}`} role="group" aria-label="Stroke Color" inert={paletteHidden ? true : undefined} aria-hidden={paletteHidden || undefined} onMouseEnter={() => setShowPalette(true)} onMouseLeave={() => setShowPalette(false)} onFocus={() => setShowPalette(true)} onBlur={() => setShowPalette(false)}>
      {STROKE_COLORS.map((c) => <button key={c} type="button" className={`relative h-5 w-5 flex-none rounded-full border transition-transform duration-150 after:absolute after:-inset-[2px] after:rounded-full after:content-[''] ${strokeColor === c ? 'scale-110 border-accent' : 'border-line hover:scale-105'}`} style={{ backgroundColor: c }} onClick={() => { onStrokeColorChange(c); if (tool !== 'draw') onToolChange('draw') }} title={STROKE_COLOR_NAMES[c]} aria-label={STROKE_COLOR_NAMES[c]} aria-pressed={strokeColor === c} />)}
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
          if (picked) chooseSuggestion(picked[0])
        }
      }} className="min-w-0 flex-1 bg-transparent px-1 text-[11px] text-text outline-none placeholder:text-text-faint" placeholder={mode === 'message' ? 'Write a message…' : `Run a command or ${commandPrefix === 'any' ? '/terminal' : `${commandPrefix}terminal`}`} aria-label="Command input" role="combobox" aria-expanded={suggestions.length > 0} aria-controls={suggestions.length > 0 ? 'command-suggestions' : undefined} aria-activedescendant={suggestions.length > 0 ? `command-suggestion-${Math.min(suggestionIndex, suggestions.length - 1)}` : undefined} autoComplete="off" />
      <button type="submit" className="grid h-7 w-7 flex-none place-items-center rounded-[8px] text-text hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-30" disabled={!canSubmit} aria-label={mode === 'message' ? 'Send message' : 'Run command'} title={mode === 'message' ? 'Send message' : 'Run command'}>↵</button>
    </form>
    <span className="mx-0.5 h-5 w-px bg-bg-hover" aria-hidden="true" />
    <select data-testid="command-mode" value={mode} onChange={(event) => setMode(event.target.value as 'command' | 'message')} className="h-7 max-w-[96px] rounded-[8px] border border-line bg-bg-raise px-1.5 text-[10px] text-text outline-none" aria-label="Command mode">
      <option value="command">Command</option>
      <option value="message">Message</option>
    </select>
    <select value={activeTerminalId} onChange={(event) => onTargetTerminalChange(event.target.value)} disabled={!terminals.length} className="h-7 max-w-[112px] rounded-[8px] border border-line bg-bg-raise px-1.5 text-[10px] text-text outline-none" aria-label="Target terminal">
      {terminals.length ? terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.title || 'Terminal'}</option>) : <option value="">No terminal</option>}
    </select>
    <button type="button" className="flex h-7 max-w-[120px] min-w-0 items-center gap-1 rounded-[8px] px-1.5 text-text hover:bg-bg-hover" onClick={onPickDir} aria-label="Change directory" title={workspaceDir || 'Change directory'}>
      <FolderOpen size={14} className="flex-none" />
      <span className="truncate text-[10px]">{dirName}</span>
    </button>
    <button type="button" className="grid h-7 w-7 flex-none place-items-center rounded-[8px] text-text hover:bg-bg-hover" onClick={openSettings} aria-label="Settings" title="Settings">
      <Settings size={14} />
    </button>
    <span className="mx-0.5 h-5 w-px bg-bg-hover" aria-hidden="true" />
    <ToolButton label="Select" testId="tool-select" active={tool === 'select'} onClick={() => onToolChange('select')}><MousePointer2 size={15} /></ToolButton>
    <ToolButton label="Eraser — drag over strokes to erase" testId="tool-erase" active={tool === 'erase'} onClick={() => onToolChange('erase')}><Eraser size={16} /></ToolButton>
    <ToolButton label="Clear all drawings" testId="tool-clear-strokes" disabled={!hasStrokes} onClick={onClearStrokes}><Trash2 size={16} /></ToolButton>
    <ToolButton label="Pan" testId="tool-pan" active={tool === 'pan'} onClick={() => onToolChange('pan')}><Hand size={16} /></ToolButton>
  </div>
}
