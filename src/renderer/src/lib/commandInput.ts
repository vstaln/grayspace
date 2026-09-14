import type { WidgetKind } from '../types'

export type CommandPrefix = '/' | '.' | '@' | 'any'

const WIDGET_ALIASES: Record<string, WidgetKind> = {
  terminal: 'terminal',
  term: 'terminal',
  sh: 'terminal',
  shell: 'terminal',
  cmd: 'terminal',
  files: 'files',
  file: 'files',
  'sys-monitor': 'sys-monitor',
  monitor: 'sys-monitor',
  sys: 'sys-monitor',
  system: 'sys-monitor',
  timer: 'timer',
  time: 'timer',
  clock: 'timer',
  planner: 'planner',
  plan: 'planner',
  tasks: 'planner',
  todo: 'planner',
  orchestration: 'orchestration',
  orc: 'orchestration',
  orch: 'orchestration',
  agents: 'orchestration',
  workers: 'orchestration',
  browser: 'browser',
  web: 'browser',
  links: 'links',
  link: 'links',
  music: 'music-player',
  'music-player': 'music-player',
  chat: 'chat',
  ai: 'chat',
  ask: 'chat'
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
