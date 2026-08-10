import { app } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage'
import { VersionRegistry } from './core/index.ts'

/**
 * Bumped whenever the persisted shape changes; {@link migrate} brings older
 * files forward. Without this every release that touches the widget shape
 * silently breaks workspaces saved by the previous one.
 */
export const CANVAS_SCHEMA_VERSION = 2

export type WidgetKind = 'terminal' | 'note' | 'git-status' | 'timer' | 'schedule' | 'board' | 'planner'

export interface CanvasWidget {
  id: string
  title: string
  kind?: WidgetKind
  noteId?: string
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized?: boolean
  maximized?: boolean
  /** Optimistic-concurrency version, owned by the Command Bus. */
  version: number
  updatedAt: number
}

export interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasStroke {
  id: string
  points: CanvasPoint[]
  color: string
}

export interface CanvasCamera {
  x: number
  y: number
  zoom: number
}

export interface CanvasSnapshot {
  schemaVersion: number
  widgets: CanvasWidget[]
  camera: CanvasCamera
  strokes: CanvasStroke[]
  /** Version of the canvas itself (camera + strokes), not of any widget. */
  version: number
}

const MAX_STROKE_POINTS = 200_000
const MAX_WIDGETS = 200

/** The single canvas object camera and stroke commands address. */
export const CANVAS_TARGET_ID = 'main'

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const WIDGET_KINDS = new Set<string>(['terminal', 'note', 'git-status', 'timer', 'schedule', 'board', 'planner'])

function sanitizeWidget(value: unknown): CanvasWidget | null {
  const w = value as Record<string, unknown>
  if (!w || typeof w.id !== 'string' || typeof w.title !== 'string') return null
  if (!isNum(w.x) || !isNum(w.y) || !isNum(w.w) || !isNum(w.h) || !isNum(w.z)) return null
  if (w.kind !== undefined && !WIDGET_KINDS.has(String(w.kind))) return null
  return {
    id: w.id,
    title: w.title,
    kind: w.kind as WidgetKind | undefined,
    noteId: typeof w.noteId === 'string' ? w.noteId : undefined,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    z: w.z,
    minimized: w.minimized === true,
    maximized: w.maximized === true,
    version: isNum(w.version) && w.version > 0 ? w.version : 1,
    updatedAt: isNum(w.updatedAt) ? w.updatedAt : Date.now()
  }
}

function sanitizeStrokes(value: unknown): CanvasStroke[] {
  if (!Array.isArray(value)) return []
  const strokes: CanvasStroke[] = []
  let points = 0
  for (const entry of value) {
    const s = entry as Record<string, unknown>
    if (!s || typeof s.id !== 'string' || typeof s.color !== 'string' || !Array.isArray(s.points)) continue
    const pts: CanvasPoint[] = []
    for (const p of s.points) {
      const point = p as Record<string, unknown>
      if (point && isNum(point.x) && isNum(point.y)) {
        pts.push({ x: point.x, y: point.y })
        if (pts.length >= 10_000) break
      }
    }
    if (pts.length < 2) continue
    strokes.push({ id: s.id, points: pts, color: s.color })
    points += pts.length
    if (points >= MAX_STROKE_POINTS) break
  }
  return strokes
}

function sanitizeCamera(value: unknown): CanvasCamera {
  const c = value as Record<string, unknown> | undefined
  if (!c || !isNum(c.x) || !isNum(c.y) || !isNum(c.zoom)) return { x: 0, y: 0, zoom: 1 }
  return { x: c.x, y: c.y, zoom: Math.min(4, Math.max(0.2, c.zoom)) }
}

/**
 * Canvas layout (widgets, camera, strokes).
 *
 * Every mutating method on this class is called from exactly one place — the
 * command handlers in `commands/canvas.ts` — and never from a transport. The
 * store's job is to hold sanitised state, keep each widget's version in step
 * with the bus, and get it to disk; deciding *who* may change it is the bus's.
 */
export class CanvasStore extends EventEmitter {
  private widgets = new Map<string, CanvasWidget>()
  private camera: CanvasCamera = { x: 0, y: 0, zoom: 1 }
  private strokes: CanvasStroke[] = []
  private loaded = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Version each widget was at the last time the renderer wrote it. Read by
   * {@link importFromRenderer} to tell "the window is echoing back its own
   * work" apart from "somebody else wrote this in between".
   */
  private readonly rendererBaseline = new Map<string, number>()
  /** Widget versions live here; the canvas's own version is tracked separately. */
  readonly widgetVersions = new VersionRegistry('widget')
  readonly canvasVersions = new VersionRegistry('canvas')

  private get file(): string {
    return join(app.getPath('userData'), 'workspace-canvas.json')
  }

  // ---- reads --------------------------------------------------------------

  load(): CanvasSnapshot {
    this.ensure()
    return this.snapshot()
  }

  snapshot(): CanvasSnapshot {
    this.ensure()
    return {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      widgets: Array.from(this.widgets.values()),
      camera: { ...this.camera },
      strokes: this.strokes,
      version: this.canvasVersions.current(CANVAS_TARGET_ID)
    }
  }

  widget(id: string): CanvasWidget | undefined {
    this.ensure()
    return this.widgets.get(id)
  }

  listWidgets(): CanvasWidget[] {
    this.ensure()
    return Array.from(this.widgets.values())
  }

  // ---- writes (command handlers only) -------------------------------------

  /** Creates or replaces a widget wholesale; returns the stored copy. */
  putWidget(input: Omit<CanvasWidget, 'version' | 'updatedAt'>): CanvasWidget {
    this.ensure()
    if (!this.widgets.has(input.id) && this.widgets.size >= MAX_WIDGETS) {
      throw new Error(`the canvas is full (${MAX_WIDGETS} widgets)`)
    }
    const widget = sanitizeWidget({ ...input, version: 1, updatedAt: Date.now() })
    if (!widget) throw new Error('malformed widget')
    widget.version = this.widgetVersions.bump(widget.id)
    this.widgets.set(widget.id, widget)
    this.changed()
    return widget
  }

  patchWidget(id: string, patch: Partial<Omit<CanvasWidget, 'id' | 'version'>>): CanvasWidget {
    this.ensure()
    const current = this.widgets.get(id)
    if (!current) throw new Error(`widget ${id} not found`)
    const merged = sanitizeWidget({ ...current, ...patch, id, version: current.version, updatedAt: Date.now() })
    if (!merged) throw new Error('malformed widget patch')
    merged.version = this.widgetVersions.bump(id)
    this.widgets.set(id, merged)
    this.changed()
    return merged
  }

  removeWidget(id: string): boolean {
    this.ensure()
    if (!this.widgets.delete(id)) return false
    this.widgetVersions.forget(id)
    this.changed()
    return true
  }

  setCamera(camera: unknown): CanvasCamera {
    this.ensure()
    this.camera = sanitizeCamera(camera)
    this.canvasVersions.bump(CANVAS_TARGET_ID)
    this.changed()
    return { ...this.camera }
  }

  setStrokes(strokes: unknown): CanvasStroke[] {
    this.ensure()
    this.strokes = sanitizeStrokes(strokes)
    this.canvasVersions.bump(CANVAS_TARGET_ID)
    this.changed()
    return this.strokes
  }

  /**
   * Bulk write from the renderer, which owns the live layout while the user
   * drags things around.
   *
   * It is a *merge*, not a replace, and the distinction is what stops the UI's
   * periodic save from silently undoing concurrent work. The rule is stated in
   * terms of {@link rendererBaseline} — the version each widget was at when
   * this window last wrote it:
   *
   * - version unchanged since that baseline → only the renderer has touched
   *   this widget, so its copy wins;
   * - version moved on → somebody else (an agent, the assistant) wrote it
   *   after the window last read it, and their write is kept;
   * - present in the store but absent from the payload → deleted in the UI,
   *   *unless* the window never knew about it, which is exactly the case for a
   *   widget an agent created moments ago.
   */
  importFromRenderer(input: { widgets?: unknown; camera?: unknown; strokes?: unknown }): {
    applied: number
    skipped: number
    removed: number
  } {
    this.ensure()
    let applied = 0
    let skipped = 0

    const incoming = Array.isArray(input.widgets) ? input.widgets : []
    const seen = new Set<string>()
    for (const raw of incoming.slice(0, MAX_WIDGETS)) {
      const widget = sanitizeWidget(raw)
      if (!widget) continue
      seen.add(widget.id)
      const current = this.widgets.get(widget.id)
      const baseline = this.rendererBaseline.get(widget.id)
      if (current && baseline !== undefined && current.version !== baseline) {
        skipped += 1
        continue
      }
      widget.version = this.widgetVersions.bump(widget.id)
      widget.updatedAt = Date.now()
      this.widgets.set(widget.id, widget)
      this.rendererBaseline.set(widget.id, widget.version)
      applied += 1
    }

    let removed = 0
    for (const id of Array.from(this.widgets.keys())) {
      if (seen.has(id) || !this.rendererBaseline.has(id)) continue
      this.widgets.delete(id)
      this.widgetVersions.forget(id)
      this.rendererBaseline.delete(id)
      removed += 1
    }

    if (input.camera !== undefined) this.camera = sanitizeCamera(input.camera)
    if (input.strokes !== undefined) this.strokes = sanitizeStrokes(input.strokes)
    this.canvasVersions.bump(CANVAS_TARGET_ID)
    this.changed()
    return { applied, skipped, removed }
  }

  // ---- persistence --------------------------------------------------------

  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    const data = migrate(raw)
    for (const entry of data.widgets) {
      const widget = sanitizeWidget(entry)
      if (widget) this.widgets.set(widget.id, widget)
      if (this.widgets.size >= MAX_WIDGETS) break
    }
    this.widgetVersions.seed(this.widgets.values())
    // The window loads exactly this snapshot on startup, so these versions are
    // its baseline: a widget missing from its first save was deleted by the
    // user, not created behind its back.
    for (const widget of this.widgets.values()) this.rendererBaseline.set(widget.id, widget.version)
    this.camera = sanitizeCamera(data.camera)
    this.strokes = sanitizeStrokes(data.strokes)
    // The canvas object starts at version 1 rather than 0 so a client that has
    // read it can send a matching baseVersion straight away.
    this.canvasVersions.bump(CANVAS_TARGET_ID)
  }

  private changed(): void {
    this.emit('change', this.snapshot())
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 400)
  }

  private flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      writeJsonAtomic(this.file, {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        widgets: Array.from(this.widgets.values()),
        camera: this.camera,
        strokes: this.strokes
      })
    } catch (err) {
      // Layout persistence is best-effort; a read-only profile must not crash.
      console.error('failed to persist canvas layout', err)
    }
  }

  dispose(): void {
    this.flush()
  }
}

/**
 * Brings an older canvas file forward. v1 had no schema marker and no widget
 * versions — the fields are filled in rather than the file being discarded,
 * because a user's layout is not worth losing over a format bump.
 */
function migrate(raw: Record<string, unknown>): { widgets: unknown[]; camera: unknown; strokes: unknown } {
  const version = Number(raw.schemaVersion) || 1
  const widgets = Array.isArray(raw.widgets) ? raw.widgets : []
  if (version >= CANVAS_SCHEMA_VERSION) return { widgets, camera: raw.camera, strokes: raw.strokes }
  const now = Date.now()
  return {
    widgets: widgets.map((w) => ({ ...(w as object), version: 1, updatedAt: now })),
    camera: raw.camera,
    strokes: raw.strokes
  }
}

/** Kept for the transitional period while callers move to {@link CanvasStore}. */
export { CanvasStore as CanvasState }
