import type { WidgetKind } from '../types'

export type CommandPrefix = '/' | '.' | '@' | 'any'

const WIDGET_ALIASES: Record<string, WidgetKind> = {
  terminal: 'terminal',
  term: 'terminal',
  files: 'files',
  file: 'files',
  'sys-monitor': 'sys-monitor',
  monitor: 'sys-monitor',
  timer: 'timer',
  planner: 'planner',
  orchestration: 'orchestration',
  browser: 'browser',
  links: 'links',
  music: 'music-player',
  'music-player': 'music-player'
}

export interface WidgetInvocation {
  kind: WidgetKind
  initialCommand: string
}

export function parseWidgetInvocation(input: string, prefix: CommandPrefix = 'any'): WidgetInvocation | null {
  const value = input.trim()
  if (!value) return null

  const first = value.split(/\s+/, 1)[0] || ''
  const hasPrefix = /^[/.@]/.test(first)
  if (prefix !== 'any') {
    if (!hasPrefix || first[0] !== prefix) return null
  }
  const name = (hasPrefix ? first.slice(1) : first).toLowerCase()
  const kind = WIDGET_ALIASES[name]
  if (!kind) return null

  return {
    kind,
    initialCommand: value.slice(first.length).trim()
  }
}
