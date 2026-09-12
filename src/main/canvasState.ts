import { EventEmitter } from 'events'
import * as fs from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import { notifyPersistError } from './persistNotifier.ts'
import {
  VersionRegistry,
  fold,
  rewind as rewindHelper,
  blame as blameHelper,
  fork as forkHelper,
  type JournalEntry,
  type ResourceId
} from './core/index.ts'


export const CANVAS_SCHEMA_VERSION = 3


export const CANVAS_SNAPSHOT_INTERVAL = 50

export type WidgetKind = 'terminal' | 'timer' | 'planner' | 'files' | 'sys-monitor' | 'browser' | 'links' | 'music-player' | 'orchestration'

export interface CanvasWidget {
  id: string
  title: string
  kind?: WidgetKind
  x: number
  y: number
  w: number
  h: number
  z: number
  maximized?: boolean

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

/** A directed arc drawn between two widgets, usually a spawn relationship. */
export interface CanvasConnection {
  id: string
  from: string
  to: string
  bornAt: number
}

export interface CanvasSnapshot {
  snapshotSeq?: number
  schemaVersion: number
  widgets: CanvasWidget[]
  camera: CanvasCamera
  strokes: CanvasStroke[]
  connections: CanvasConnection[]

  version: number
}

export interface CanvasDataState {
  widgets: Map<string, CanvasWidget>
  camera: CanvasCamera
  strokes: CanvasStroke[]
  connections: CanvasConnection[]
  version: number
}

const MAX_STROKE_POINTS = 200_000
const MAX_WIDGETS = 200
/** One arc per ordered widget pair, so the cap tracks the widget cap. */
const MAX_CONNECTIONS = 2_000


export const CANVAS_TARGET_ID = 'main'

const EMPTY_WORKSPACE_SLOT = '__no-workspace__'
type WorkspaceChangeListener = (dir: string | undefined) => void
const workspaceChangeListeners = new Set<WorkspaceChangeListener>()


export function registerCanvasWorkspaceListener(listener: WorkspaceChangeListener): void {
  workspaceChangeListeners.add(listener)
}

export function notifyCanvasWorkspaceChanged(dir: string | undefined): void {
  for (const listener of workspaceChangeListeners) listener(dir)
}

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)




















const WIDGET_KINDS = new Set<string>(['terminal', 'timer', 'planner', 'files', 'sys-monitor', 'browser', 'links', 'music-player', 'orchestration'])

export function sanitizeWidget(value: unknown): CanvasWidget | null {
  const w = value as Record<string, unknown>
  if (!w || typeof w.id !== 'string' || typeof w.title !== 'string') return null
  if (!isNum(w.x) || !isNum(w.y) || !isNum(w.w) || !isNum(w.h) || !isNum(w.z)) return null
  if (w.kind !== undefined && !WIDGET_KINDS.has(String(w.kind))) return null
  return {
    id: w.id,
    title: w.title,
    kind: w.kind as WidgetKind | undefined,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    z: w.z,
    maximized: w.maximized === true,
    version: isNum(w.version) && w.version > 0 ? w.version : 1,
    updatedAt: isNum(w.updatedAt) ? w.updatedAt : Date.now()
  }
}

export function sanitizeStrokesJs(value: unknown): CanvasStroke[] {
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







        pts.push({ x: point.x + 0, y: point.y + 0 })
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

function sanitizeStrokes(value: unknown): CanvasStroke[] {

  return sanitizeStrokesJs(value ?? [])
}

function strokesShapeMatch(current: CanvasStroke[], incoming: unknown): boolean {
  if (!Array.isArray(incoming) || incoming.length !== current.length) return false
  for (let i = 0; i < current.length; i += 1) {
    const raw = incoming[i] as { id?: unknown; color?: unknown; points?: unknown } | null
    if (!raw || raw.id !== current[i].id || raw.color !== current[i].color) return false
    if (!Array.isArray(raw.points) || raw.points.length !== current[i].points.length) return false
  }
  return true
}

function sanitizeConnections(value: unknown): CanvasConnection[] {
  if (!Array.isArray(value)) return []
  const connections: CanvasConnection[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const c = entry as Record<string, unknown> | null
    if (!c || typeof c.id !== 'string' || typeof c.from !== 'string' || typeof c.to !== 'string') continue
    if (!c.from || !c.to || c.from === c.to) continue
    // An arc is identified by the pair, not by its generated id: replaying a
    // journal that recorded the same link twice must not stack two of them.
    const pair = `${c.from} ${c.to}`
    if (seen.has(pair)) continue
    seen.add(pair)
    connections.push({
      id: c.id,
      from: c.from,
      to: c.to,
      bornAt: isNum(c.bornAt) ? c.bornAt : Date.now()
    })
    if (connections.length >= MAX_CONNECTIONS) break
  }
  return connections
}

/** Arcs whose endpoints are both still on the canvas. */
function liveConnections(connections: CanvasConnection[], widgets: Map<string, CanvasWidget>): CanvasConnection[] {
  const next = connections.filter((c) => widgets.has(c.from) && widgets.has(c.to))
  return next.length === connections.length ? connections : next
}

function sanitizeCamera(value: unknown): CanvasCamera {
  const c = value as Record<string, unknown> | undefined
  if (!c || !isNum(c.x) || !isNum(c.y) || !isNum(c.zoom)) return { x: 0, y: 0, zoom: 1 }
  return { x: c.x, y: c.y, zoom: Math.min(4, Math.max(0.2, c.zoom)) }
}






export class CanvasStore extends EventEmitter {
  private widgets = new Map<string, CanvasWidget>()
  private camera: CanvasCamera = { x: 0, y: 0, zoom: 1 }
  private strokes: CanvasStroke[] = []
  private connections: CanvasConnection[] = []
  private loaded = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0
  private syncFlushSeq = 0
  private readonly rendererBaseline = new Map<string, number>()
  private snapshotSeq = 0
  private eventsSinceSnapshot = 0
  readonly widgetVersions = new VersionRegistry('widget')
  readonly canvasVersions = new VersionRegistry('canvas')

  private workspaceDir: string | undefined

  get activeWorkspaceDir(): string | undefined {
    this.ensure()
    return this.workspaceDir
  }

  constructor() {
    super()
    registerCanvasWorkspaceListener((dir) => this.switchWorkspace(dir))
  }

  private get file(): string {
    const slot = this.workspaceSlot(this.workspaceDir ?? this.readActiveWorkspaceDir())
    return join(getUserDataDir(), `workspace-canvas-${slot}.json`)
  }

  private workspaceSlot(dir: string | undefined): string {
    if (!dir) return EMPTY_WORKSPACE_SLOT
    return createHash('sha256').update(dir).digest('hex').slice(0, 32)
  }

  private readActiveWorkspaceDir(): string | undefined {
    const raw = readStoreJson<Record<string, unknown>>(
      join(getUserDataDir(), 'workspace-state.json'),
      {}
    )
    return typeof raw.workspaceDir === 'string' && raw.workspaceDir ? raw.workspaceDir : undefined
  }

  private switchWorkspace(dir: string | undefined): void {
    if (this.workspaceDir === dir && this.loaded) return
    if (this.loaded) {




      if (this.saveTimer !== null) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      if (this.changeTimer !== null) {
        clearTimeout(this.changeTimer)
        this.changeTimer = null
      }
      try {
        this.flush()
      } catch {
        this.flushAsync()
      }
    }
    this.workspaceDir = dir
    this.loaded = false
    for (const id of this.widgets.keys()) this.widgetVersions.forget(id)
    this.canvasVersions.forget(CANVAS_TARGET_ID)
    this.widgets.clear()
    this.camera = { x: 0, y: 0, zoom: 1 }
    this.strokes = []
    this.rendererBaseline.clear()
    const snapshot = this.load()
    this.emit('change', snapshot)
  }






  static reduce(state: CanvasDataState, event: JournalEntry): CanvasDataState {
    if (event.phase !== 'commit') return state






    let nextWidgets = state.widgets
    let nextCamera = state.camera
    let nextStrokes = state.strokes
    let nextConnections = state.connections
    let nextVersion = state.version
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const targetId = event.target.startsWith('widget:') ? event.target.slice('widget:'.length) : event.target

    const mutableWidgets = (): Map<string, CanvasWidget> => {
      if (nextWidgets === state.widgets) nextWidgets = new Map(state.widgets)
      return nextWidgets
    }

    if (event.type === 'widget.create') {
      const widget = sanitizeWidget({
        ...payload,
        id: targetId === 'new' ? (payload.id as string) || `widget-${event.at}-${event.seq}` : targetId,
        version: event.version ?? 1,
        updatedAt: event.at
      })
      if (widget) mutableWidgets().set(widget.id, widget)
    } else if (event.type === 'widget.update') {
      const existing = nextWidgets.get(targetId)
      if (existing) {
        const merged = sanitizeWidget({
          ...existing,
          ...payload,
          id: targetId,
          version: event.version ?? existing.version + 1,
          updatedAt: event.at
        })
        if (merged) mutableWidgets().set(targetId, merged)
      }
    } else if (event.type === 'widget.remove') {
      if (nextWidgets.has(targetId)) {
        mutableWidgets().delete(targetId)
        // An arc to a widget that no longer exists has nothing to draw between,
        // so it is dropped with the widget rather than left to accumulate.
        nextConnections = liveConnections(nextConnections, nextWidgets)
      }
    } else if (event.type === 'canvas.camera') {
      nextCamera = sanitizeCamera(payload)
      nextVersion = event.version ?? nextVersion + 1
    } else if (event.type === 'canvas.strokes') {
      nextStrokes = sanitizeStrokes(payload.strokes)
      nextVersion = event.version ?? nextVersion + 1
    } else if (event.type === 'canvas.connections') {
      nextConnections = liveConnections(sanitizeConnections(payload.connections), nextWidgets)
      nextVersion = event.version ?? nextVersion + 1
    } else if (event.type === 'canvas.import') {
      if (Array.isArray(payload.widgets)) {
        for (const w of payload.widgets) {
          const widget = sanitizeWidget(w)
          if (widget) mutableWidgets().set(widget.id, widget)
        }
      }
      if (payload.camera !== undefined) nextCamera = sanitizeCamera(payload.camera)
      if (payload.strokes !== undefined) nextStrokes = sanitizeStrokes(payload.strokes)
      // Filtered after the widget loop above, so a snapshot carrying a widget
      // and an arc to it in the same payload keeps the arc whatever order the
      // two appear in.
      if (payload.connections !== undefined) {
        nextConnections = liveConnections(sanitizeConnections(payload.connections), nextWidgets)
      }
      nextVersion = event.version ?? nextVersion + 1
    }

    return {
      widgets: nextWidgets,
      camera: nextCamera,
      strokes: nextStrokes,
      // Deliberately not re-filtered here: only the three branches above can
      // orphan an arc, and they each do their own. A blanket pass would run on
      // every widget.update instead — once per frame of every drag.
      connections: nextConnections,
      version: nextVersion
    }
  }




  applyEvent(event: JournalEntry): void {
    if (event.phase !== 'commit') return
    const current: CanvasDataState = {
      widgets: this.widgets,
      camera: this.camera,
      strokes: this.strokes,
      connections: this.connections,
      version: this.canvasVersions.current(CANVAS_TARGET_ID)
    }
    const nextState = CanvasStore.reduce(current, event)



    this.widgets = nextState.widgets
    this.camera = nextState.camera
    this.strokes = nextState.strokes
    this.connections = nextState.connections

    if (typeof event.version === 'number') {
      if (event.target.startsWith('widget:')) {
        const id = event.target.slice('widget:'.length)
        if (event.type === 'widget.remove') this.widgetVersions.forget(id)
        else this.widgetVersions.seed([{ id, version: event.version }])
      } else if (event.target.startsWith('canvas:')) {
        this.canvasVersions.seed([{ id: CANVAS_TARGET_ID, version: event.version }])
      }
    }
    if (event.seq > this.snapshotSeq) {
      this.snapshotSeq = event.seq
    }
    this.eventsSinceSnapshot += 1
    if (this.eventsSinceSnapshot >= CANVAS_SNAPSHOT_INTERVAL) {



      this.flushAsync()
    }
  }

  foldEvents(events: Iterable<JournalEntry>, initialState?: CanvasDataState): CanvasDataState {
    const start: CanvasDataState = initialState ?? {
      widgets: new Map(),
      camera: { x: 0, y: 0, zoom: 1 },
      strokes: [],
      connections: [],
      version: 1
    }
    return fold(events, CanvasStore.reduce, start)
  }



  private ensure(tailEvents?: JournalEntry[]): void {
    if (this.loaded) return
    const workspaceDir = this.workspaceDir ?? this.readActiveWorkspaceDir()
    this.workspaceDir = workspaceDir



    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    const legacyFile = join(getUserDataDir(), 'workspace-canvas.json')
    const alreadyMigrated = (() => {
      try {
        return fs.existsSync(`${legacyFile}.migrated`)
      } catch {
        return false
      }
    })()



    const legacy = Object.keys(raw).length === 0 && !alreadyMigrated
      ? readStoreJson<Record<string, unknown>>(legacyFile, {})
      : {}
    this.loaded = true
    const source = Object.keys(legacy).length > 0 ? legacy : raw
    const data = migrate(source)
    let removedNoteWidget = false
    for (const entry of data.widgets) {
      if ((entry as Record<string, unknown> | null)?.kind === 'note') removedNoteWidget = true
      const widget = sanitizeWidget(entry)
      if (widget) this.widgets.set(widget.id, widget)
      if (this.widgets.size >= MAX_WIDGETS) break
    }
    this.snapshotSeq = Number(raw.snapshotSeq) || 0
    this.widgetVersions.seed(this.widgets.values())
    for (const widget of this.widgets.values()) this.rendererBaseline.set(widget.id, widget.version)
    this.camera = sanitizeCamera(data.camera)
    this.strokes = sanitizeStrokes(data.strokes)
    // Canvases written before arcs were persisted simply have no field here,
    // which sanitises to an empty list — the behaviour they already had.
    this.connections = liveConnections(sanitizeConnections(data.connections), this.widgets)
    const persisted = isNum(data.version) && data.version > 0 ? data.version : 1
    this.canvasVersions.seed([{ id: CANVAS_TARGET_ID, version: persisted }])


    if (tailEvents && tailEvents.length > 0) {
      const tailToApply = tailEvents.filter((e) => e.seq > this.snapshotSeq && e.phase === 'commit')
      if (tailToApply.length > 0) {
        const replayed = this.foldEvents(tailToApply, {
          widgets: this.widgets,
          camera: this.camera,
          strokes: this.strokes,
          connections: this.connections,
          version: this.canvasVersions.current(CANVAS_TARGET_ID)
        })
        this.widgets = replayed.widgets
        this.camera = replayed.camera
        this.strokes = replayed.strokes
        this.connections = replayed.connections
        this.widgetVersions.seed(this.widgets.values())
        this.canvasVersions.seed([{ id: CANVAS_TARGET_ID, version: replayed.version }])
        this.snapshotSeq = Math.max(this.snapshotSeq, ...tailToApply.map((e) => e.seq))
      }
    }



    if (removedNoteWidget) this.flush()

    if (Object.keys(legacy).length > 0) {
      this.flush()
      try {
        fs.renameSync(legacyFile, `${legacyFile}.migrated`)
      } catch (err) {
        console.error(`failed to retire legacy canvas file ${legacyFile}`, err)
      }
    }
  }

  loadWithTail(tailEvents: JournalEntry[]): void {
    this.loaded = false
    this.widgets.clear()
    this.ensure(tailEvents)
  }



  rewind(targetSeq: number, events: Iterable<JournalEntry> = []): CanvasSnapshot {
    this.ensure()
    const rewoundState = rewindHelper(
      targetSeq,
      events,
      CanvasStore.reduce,
      {
        snapshotSeq: 0,
        state: {
          widgets: new Map<string, CanvasWidget>(),
          camera: { x: 0, y: 0, zoom: 1 },
          strokes: [],
          connections: [],
          version: 1
        }
      }
    )
    return {
      snapshotSeq: targetSeq,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      widgets: Array.from(rewoundState.widgets.values()),
      camera: { ...rewoundState.camera },
      strokes: rewoundState.strokes,
      connections: rewoundState.connections,
      version: rewoundState.version
    }
  }

  blame(target: ResourceId, events: Iterable<JournalEntry> = []): JournalEntry[] {
    return blameHelper(target, events)
  }

  replay(events: Iterable<JournalEntry>, fromState?: CanvasDataState): CanvasSnapshot {
    const start: CanvasDataState = fromState ?? {
      widgets: new Map(),
      camera: { x: 0, y: 0, zoom: 1 },
      strokes: [],
      connections: [],
      version: 1
    }
    const state = fold(events, CanvasStore.reduce, start)
    return {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      widgets: Array.from(state.widgets.values()),
      camera: { ...state.camera },
      strokes: state.strokes,
      connections: state.connections,
      version: state.version
    }
  }

  fork(forkId: string, atSeq?: number, events?: Iterable<JournalEntry>): CanvasSnapshot {
    this.ensure()
    if (typeof atSeq === 'number' && events) {
      return this.rewind(atSeq, events)
    }
    const forkedWidgets = forkHelper(forkId, this.widgets)
    return {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      widgets: Array.from(forkedWidgets.values()),
      camera: { ...this.camera },
      strokes: this.strokes.slice(),
      connections: this.connections.slice(),
      version: this.canvasVersions.current(CANVAS_TARGET_ID)
    }
  }



  load(): CanvasSnapshot {
    this.ensure()
    return this.snapshot()
  }

  snapshot(overlayId?: string): CanvasSnapshot {
    this.ensure()
    const rawWidgets = Array.from(this.widgets.values())
    const widgets = overlayId && this.widgetVersions.hasOverlay(overlayId)
      ? rawWidgets.map((w) => ({ ...w, version: this.widgetVersions.current(w.id, overlayId) }))
      : rawWidgets
    return {
      snapshotSeq: this.snapshotSeq,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      widgets,
      camera: { ...this.camera },
      strokes: this.strokes,
      connections: this.connections,
      version: this.canvasVersions.current(CANVAS_TARGET_ID, overlayId)
    }
  }

  widget(id: string, overlayId?: string): CanvasWidget | undefined {
    this.ensure()
    const w = this.widgets.get(id)
    if (!w) return undefined
    if (overlayId && this.widgetVersions.hasOverlay(overlayId)) {
      return { ...w, version: this.widgetVersions.current(id, overlayId) }
    }
    return w
  }

  listWidgets(overlayId?: string): CanvasWidget[] {
    this.ensure()
    const rawWidgets = Array.from(this.widgets.values())
    if (overlayId && this.widgetVersions.hasOverlay(overlayId)) {
      return rawWidgets.map((w) => ({ ...w, version: this.widgetVersions.current(w.id, overlayId) }))
    }
    return rawWidgets
  }



  putWidget(input: Omit<CanvasWidget, 'version' | 'updatedAt'>, overlayId?: string): CanvasWidget {
    this.ensure()
    if (!this.widgets.has(input.id) && this.widgets.size >= MAX_WIDGETS) {
      throw new Error(`the canvas is full (${MAX_WIDGETS} widgets)`)
    }
    const widget = sanitizeWidget({ ...input, version: 1, updatedAt: Date.now() })
    if (!widget) throw new Error('malformed widget')
    widget.version = this.widgetVersions.bump(widget.id, overlayId)
    this.widgets.set(widget.id, widget)
    this.eventsSinceSnapshot += 1
    this.changed()
    return widget
  }

  patchWidget(id: string, patch: Partial<Omit<CanvasWidget, 'id' | 'version'>>, overlayId?: string): CanvasWidget {
    this.ensure()
    const current = this.widgets.get(id)
    if (!current) throw new Error(`widget ${id} not found`)
    const merged = sanitizeWidget({ ...current, ...patch, id, version: current.version, updatedAt: Date.now() })
    if (!merged) throw new Error('malformed widget patch')
    merged.version = this.widgetVersions.bump(id, overlayId)
    this.widgets.set(id, merged)
    this.eventsSinceSnapshot += 1
    this.changed()
    return merged
  }

  patchWidgets(
    patches: Array<{ id: string; patch: Partial<Omit<CanvasWidget, 'id' | 'version'>> }>,
    overlayId?: string
  ): CanvasWidget[] {
    this.ensure()
    const updated: CanvasWidget[] = []
    for (const { id, patch } of patches) {
      const current = this.widgets.get(id)
      if (!current) continue
      const merged = sanitizeWidget({ ...current, ...patch, id, version: current.version, updatedAt: Date.now() })
      if (merged) {
        merged.version = this.widgetVersions.bump(id, overlayId)
        this.widgets.set(id, merged)
        updated.push(merged)
      }
    }
    if (updated.length > 0) {
      this.eventsSinceSnapshot += updated.length
      this.changed()
    }
    return updated
  }

  removeWidget(id: string, overlayId?: string): boolean {
    this.ensure()
    if (!this.widgets.delete(id)) return false
    this.widgetVersions.forget(id, overlayId)
    this.rendererBaseline.delete(id)
    this.eventsSinceSnapshot += 1
    this.changed()
    return true
  }

  setCamera(camera: unknown, overlayId?: string): CanvasCamera {
    this.ensure()
    const next = sanitizeCamera(camera)
    if (next.x === this.camera.x && next.y === this.camera.y && next.zoom === this.camera.zoom) {
      return { ...this.camera }
    }
    this.camera = next
    this.canvasVersions.bump(CANVAS_TARGET_ID, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
    return { ...this.camera }
  }

  setStrokes(strokes: unknown, overlayId?: string): CanvasStroke[] {
    this.ensure()
    const next = sanitizeStrokes(strokes)
    if (next.length === this.strokes.length && next.every((s, i) => s === this.strokes[i])) {
      return this.strokes
    }
    this.strokes = next
    this.canvasVersions.bump(CANVAS_TARGET_ID, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
    return this.strokes
  }

  setConnections(connections: unknown, overlayId?: string): CanvasConnection[] {
    this.ensure()
    const next = liveConnections(sanitizeConnections(connections), this.widgets)
    const same = next.length === this.connections.length &&
      next.every((c, i) => c.id === this.connections[i].id && c.from === this.connections[i].from && c.to === this.connections[i].to)
    if (same) return this.connections
    this.connections = next
    this.canvasVersions.bump(CANVAS_TARGET_ID, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
    return this.connections
  }

  importFromRenderer(input: { widgets?: unknown; camera?: unknown; strokes?: unknown; connections?: unknown }, overlayId?: string): {
    applied: number
    skipped: number
    removed: number
    removedWidgets: Array<{ id: string; kind?: WidgetKind }>
  } {
    this.ensure()
    let applied = 0
    let skipped = 0

    const incoming = Array.isArray(input.widgets) ? input.widgets : null
    const seen = new Set<string>()

    const slicedIncoming = (() => {
      if (!incoming || incoming.length <= MAX_WIDGETS) return incoming ?? []
      const scored = incoming
        .map((raw, idx) => {
          const at = (raw as Record<string, unknown>)?.updatedAt
          const num = typeof at === 'number' && Number.isFinite(at) ? at : 0
          return { raw, idx, at: num }
        })
        .sort((a, b) => b.at - a.at || a.idx - b.idx)
        .slice(0, MAX_WIDGETS)
        .sort((a, b) => a.idx - b.idx)
        .map((x) => x.raw)
      console.warn(`canvas import truncated ${incoming.length}→${MAX_WIDGETS}, dropped oldest`)
      return scored
    })()
    for (const raw of slicedIncoming) {
      const widget = sanitizeWidget(raw)
      if (!widget) continue
      seen.add(widget.id)
      const current = this.widgets.get(widget.id)
      if (current && widget.version !== current.version) {
        skipped += 1
        continue
      }
      widget.version = this.widgetVersions.bump(widget.id, overlayId)
      widget.updatedAt = Date.now()
      this.widgets.set(widget.id, widget)
      this.rendererBaseline.set(widget.id, widget.version)
      applied += 1
    }

    let removed = 0
    const removedWidgets: Array<{ id: string; kind?: WidgetKind }> = []
    if (incoming) {
      for (const id of Array.from(this.widgets.keys())) {
        if (seen.has(id) || !this.rendererBaseline.has(id)) continue
        const gone = this.widgets.get(id)
        removedWidgets.push({ id, kind: gone?.kind })
        this.widgets.delete(id)
        this.widgetVersions.forget(id, overlayId)
        this.rendererBaseline.delete(id)
        removed += 1
      }
    }

    let layoutChanged = false
    if (input.camera !== undefined) {
      const next = sanitizeCamera(input.camera)
      if (next.x !== this.camera.x || next.y !== this.camera.y || next.zoom !== this.camera.zoom) {
        this.camera = next
        layoutChanged = true
      }
    }
    if (input.strokes !== undefined && !strokesShapeMatch(this.strokes, input.strokes)) {
      this.strokes = sanitizeStrokes(input.strokes)
      layoutChanged = true
    }
    if (input.connections !== undefined) {
      const nextConnections = liveConnections(sanitizeConnections(input.connections), this.widgets)
      const same = nextConnections.length === this.connections.length &&
        nextConnections.every((c, i) => c.from === this.connections[i].from && c.to === this.connections[i].to)
      if (!same) {
        this.connections = nextConnections
        layoutChanged = true
      }
    } else if (removed > 0) {
      // The renderer did not send arcs, but widgets just disappeared — the
      // arcs that pointed at them must not outlive them.
      const pruned = liveConnections(this.connections, this.widgets)
      if (pruned !== this.connections) {
        this.connections = pruned
        layoutChanged = true
      }
    }
    if (applied === 0 && removed === 0 && !layoutChanged) {
      return { applied, skipped, removed, removedWidgets }
    }
    if (layoutChanged) this.canvasVersions.bump(CANVAS_TARGET_ID, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
    return { applied, skipped, removed, removedWidgets }
  }



  private changed(): void {
    if (this.changeTimer === null) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null
        this.emit('change', this.snapshot())
      }, 50)
      this.changeTimer.unref?.()
    }
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushAsync()
    }, 400)
    this.saveTimer.unref?.()
  }

  private snapshotForPersist(): {
    snapshotSeq: number
    schemaVersion: number
    widgets: CanvasWidget[]
    camera: CanvasCamera
    strokes: CanvasStroke[]
    connections: CanvasConnection[]
    version: number
  } {
    return {
      snapshotSeq: this.snapshotSeq,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      widgets: Array.from(this.widgets.values()),
      camera: this.camera,
      strokes: this.strokes,
      connections: this.connections,
      version: this.canvasVersions.current(CANVAS_TARGET_ID)
    }
  }

  private flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.loaded) return
    try {
      writeJsonAtomic(this.file, this.snapshotForPersist())


      this.syncFlushSeq = this.writeSeq
      this.eventsSinceSnapshot = 0
    } catch (err) {
      notifyPersistError('canvas', err)
    }
  }

  private flushAsync(): void {
    if (!this.loaded) return
    this.writeSeq += 1
    const seq = this.writeSeq
    const snapshot = this.snapshotForPersist()




    const file = this.file




    this.writeChain = this.writeChain
      .catch(() => {

      })
      .then(async (): Promise<boolean> => {


        if (seq <= this.syncFlushSeq) return false
        await writeJsonAtomicAsync(file, snapshot)
        this.eventsSinceSnapshot = 0
        return true
      })
      .then((wrote) => {
        if (!wrote) return







        if (this.syncFlushSeq >= seq && file === this.file) {
          try {
            writeJsonAtomic(file, this.snapshotForPersist())
            this.eventsSinceSnapshot = 0
          } catch (err) {
            notifyPersistError('canvas', err)
          }
        }
      })
      .catch((err: unknown) => {
        notifyPersistError('canvas', err)
      })



  }

  dispose(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.changeTimer !== null) {
      clearTimeout(this.changeTimer)
      this.changeTimer = null
    }
    this.flush()
  }
}

function migrate(
  raw: Record<string, unknown>
): { widgets: unknown[]; camera: unknown; strokes: unknown; connections: unknown; version?: unknown } {
  const version = Number(raw.schemaVersion) || 1
  const widgets = Array.isArray(raw.widgets) ? raw.widgets : []
  // `connections` needs no migration step of its own: a canvas written before
  // arcs were persisted has no such key, and `undefined` sanitises to an empty
  // list — which is exactly the state those canvases were already in.
  if (version >= CANVAS_SCHEMA_VERSION) {
    return { widgets, camera: raw.camera, strokes: raw.strokes, connections: raw.connections, version: raw.version }
  }
  const now = Date.now()
  return {
    widgets:
      version < 2
        ? widgets.map((w) => ({ ...(w as object), version: 1, updatedAt: now }))
        : widgets,
    camera: raw.camera,
    strokes: raw.strokes,
    connections: raw.connections,
    version: raw.version
  }
}

export { CanvasStore as CanvasState }
