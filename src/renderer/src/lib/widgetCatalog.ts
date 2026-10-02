import type { WidgetKind } from '../types'

export interface WidgetCatalogEntry {
  kind: WidgetKind
  label: string
  hint: string
}

/** The single user-facing catalog shared by commands, context menu and settings. */
export const WIDGET_CATALOG = [
  { kind: 'terminal', label: 'Terminal', hint: 'Shell in the current workspace' },
  { kind: 'files', label: 'Files', hint: 'Browse workspace files' },
  { kind: 'planner', label: 'Planner', hint: 'Daily agenda and checklist' },
  { kind: 'orchestration', label: 'Orchestration', hint: 'The agent fleet: tasks, workers and their questions' },
  { kind: 'browser', label: 'Browser', hint: 'Embedded web page' },
] as const satisfies readonly WidgetCatalogEntry[]
