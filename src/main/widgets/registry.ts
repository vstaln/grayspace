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
    kind: 'browser',
    label: 'Browser',
    defaultSize: { w: 720, h: 480 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({


    kind: 'orchestration',
    label: 'Orchestration',
    defaultSize: { w: 520, h: 560 },
    commands: ['orc.send', 'gate.resolve', 'dispatch.account', 'run.close', 'widget.update', 'widget.remove']
  })
}
