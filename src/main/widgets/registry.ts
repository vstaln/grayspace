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
    kind: 'note',
    label: 'Note',
    defaultSize: { w: 460, h: 340 },
    commands: ['note.create', 'note.update', 'note.delete', 'widget.update', 'widget.remove']
  })
  registerWidgetType({
    kind: 'git-status',
    label: 'Repository',
    defaultSize: { w: 320, h: 220 },
    contended: true,
    commands: ['git.refresh', 'git.commit', 'widget.update', 'widget.remove']
  })
}
