import type { WidgetKind } from '../canvasState'

/**
 * What a widget type declares about itself.
 *
 * The contract is deliberately thin, and one line of it carries the weight:
 * `commands` is the *complete* list of ways this widget may change state. A
 * widget type has no store access, no IPC channel of its own and no direct
 * filesystem reach — it submits commands like every other actor, or it does
 * nothing. That is what stops a plugin system from becoming a fifth write
 * path, which is the whole problem the unified core exists to remove.
 */
export interface WidgetType {
  kind: WidgetKind
  /** Shown in the toolbar / context menu. */
  label: string
  /** Default size when one is placed without an explicit geometry. */
  defaultSize: { w: number; h: number }
  /** Command types this widget may submit. Anything else is rejected. */
  commands: readonly string[]
  /**
   * Whether the widget owns an out-of-process resource (a PTY, a repository)
   * that must be locked before it is written to. Purely declarative — the bus
   * enforces the lock either way — but the UI reads it to show a busy chip.
   */
  contended?: boolean
}

const types = new Map<WidgetKind, WidgetType>()

export function registerWidgetType(type: WidgetType): void {
  types.set(type.kind, type)
}

export function widgetType(kind: WidgetKind | undefined): WidgetType | undefined {
  return kind ? types.get(kind) : undefined
}

export function widgetTypes(): WidgetType[] {
  return Array.from(types.values())
}

/**
 * True when this widget type is allowed to submit this command. The bus is
 * still the thing that decides whether the *actor* may write; this is the
 * narrower question of whether the widget is out of its lane.
 */
export function widgetMayRun(kind: WidgetKind | undefined, command: string): boolean {
  const type = widgetType(kind)
  return !!type && type.commands.includes(command)
}

/** The first-party widget types. Third-party ones would register the same way. */
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
    kind: 'board',
    label: 'Task board',
    defaultSize: { w: 900, h: 520 },
    commands: ['task.create', 'task.update', 'task.delete', 'task.claim', 'widget.update', 'widget.remove']
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
    kind: 'links',
    label: 'Links',
    defaultSize: { w: 420, h: 360 },
    commands: ['widget.update', 'widget.remove']
  })
  registerWidgetType({
    // Read-only over the fleet, plus the three writes only a human makes:
    // answering a blocked worker, resolving a gate, releasing a finished one.
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
    kind: 'id-generator',
    label: 'ID Generator',
    defaultSize: { w: 420, h: 360 },
    commands: ['widget.update', 'widget.remove']
  })
}
