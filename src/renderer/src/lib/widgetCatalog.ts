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
  { kind: 'sys-monitor', label: 'System Monitor', hint: 'CPU, RAM and processes' },
  { kind: 'timer', label: 'Timer', hint: 'Countdown or stopwatch' },
  { kind: 'planner', label: 'Planner', hint: 'Daily agenda and checklist' },
  { kind: 'orchestration', label: 'Orchestration', hint: 'The agent fleet: tasks, workers and their questions' },
  { kind: 'browser', label: 'Browser', hint: 'Embedded web page' },
  { kind: 'image', label: 'Image', hint: 'Pinned image from the clipboard or a file' },
  { kind: 'links', label: 'Links', hint: 'Saved links' },
  { kind: 'music-player', label: 'Music Player', hint: 'Stream YouTube, Yandex Music, Spotify or MP3 links' },
  { kind: 'chat', label: 'AI Chat', hint: 'Chat with an authenticated model' },
  { kind: 'notes', label: 'Notes', hint: 'Tagged notes with a color per category' },
  { kind: 'calendar', label: 'Calendar', hint: 'Month view of your planner tasks' },
  { kind: 'kanban', label: 'Kanban', hint: 'Todo / Doing / Done board for your planner tasks' }
] as const satisfies readonly WidgetCatalogEntry[]
