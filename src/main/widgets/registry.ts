import type { WidgetKind } from '../canvasState'











export interface WidgetType {
  kind: WidgetKind

  label: string

  defaultSize: { w: number; h: number }

  commands: readonly string[]





  contended?: boolean
}

const types = new Map<WidgetKind, WidgetType>()

export function registerWidgetType(type: WidgetType): void {
  types.set(type.kind, type)
}
export function widgetType(kind: WidgetKind | undefined): WidgetType | undefined {
  return kind ? types.get(kind) : undefined
}

export function registerBuiltinWidgets(): void {
  registerWidgetType({
    kind: 'terminal',
    label: 'Terminal',
    defaultSize: { w: 620, h: 380 },
    contended: true,
    commands: ['terminal.spawn', 'terminal.input', 'terminal.write', 'terminal.resize', 'terminal.dispose', 'widget.update']
  })
  registerWidgetType({
    kind: 'timer',
    label: 'Timer',
    defaultSize: { w: 300, h: 220 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'planner',
    label: 'Planner',
    defaultSize: { w: 420, h: 520 },
    commands: ['plan.create', 'plan.update', 'plan.toggle', 'plan.delete', 'widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'files',
    label: 'Files',
    defaultSize: { w: 580, h: 480 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'sys-monitor',
    label: 'System Monitor',
    defaultSize: { w: 440, h: 380 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'browser',
    label: 'Browser',
    defaultSize: { w: 720, h: 480 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'image',
    label: 'Image',
    defaultSize: { w: 560, h: 420 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'links',
    label: 'Links',
    defaultSize: { w: 420, h: 360 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({


    kind: 'orchestration',
    label: 'Orchestration',
    defaultSize: { w: 520, h: 560 },
    commands: ['orc.send', 'gate.resolve', 'dispatch.account', 'run.close', 'widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'music-player',
    label: 'Music Player',
    defaultSize: { w: 460, h: 330 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'chat',
    label: 'AI Chat',
    defaultSize: { w: 560, h: 560 },
    commands: ['chat.send', 'chat.cancel', 'widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'notes',
    label: 'Notes',
    defaultSize: { w: 520, h: 540 },
    commands: ['note.create', 'note.update', 'note.delete', 'widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'calendar',
    label: 'Calendar',
    defaultSize: { w: 560, h: 520 },
    commands: ['plan.create', 'plan.update', 'plan.toggle', 'plan.delete', 'widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'kanban',
    label: 'Kanban',
    defaultSize: { w: 760, h: 520 },
    commands: ['plan.create', 'plan.update', 'plan.toggle', 'plan.delete', 'widget.update', 'widget.remove']
  })
}
