import { app } from 'electron'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage'

export interface CanvasWidget {
  id: string
  title: string
  kind?: 'terminal' | 'note'
  noteId?: string
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized?: boolean
  maximized?: boolean
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

export interface CanvasSnapshot {
  widgets: CanvasWidget[]
  camera: { x: number; y: number; zoom: number }
  strokes: CanvasStroke[]
}

const MAX_STROKE_POINTS = 200_000
const MAX_WIDGETS = 200

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function sanitizeWidget(value: unknown): CanvasWidget | null {
  const w = value as Record<string, unknown>
  if (!w || typeof w.id !== 'string' || typeof w.title !== 'string') return null
  if (!isNum(w.x) || !isNum(w.y) || !isNum(w.w) || !isNum(w.h) || !isNum(w.z)) return null
  if (w.kind !== undefined && w.kind !== 'terminal' && w.kind !== 'note') return null
  return {
    id: w.id,
    title: w.title,
    kind: w.kind as CanvasWidget['kind'],
    noteId: typeof w.noteId === 'string' ? w.noteId : undefined,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    z: w.z,
    minimized: w.minimized === true,
    maximized: w.maximized === true
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

/**
 * Persists the canvas layout (widgets, camera, strokes) so a restart restores
 * the desktop instead of wiping it — DI-004. The renderer owns the debounce;
 * this store only sanitizes and writes atomically (with .bak protection).
 */
export class CanvasState {
  private snapshot: CanvasSnapshot = emptySnapshot()
  private loaded = false
  private get file(): string { return join(app.getPath('userData'), 'workspace-canvas.json') }

  load(): CanvasSnapshot {
    if (this.loaded) return this.snapshot
    this.loaded = true
    const raw = readStoreJson<Partial<CanvasSnapshot>>(this.file, {})
    const widgets = (Array.isArray(raw.widgets) ? raw.widgets : [])
      .map(sanitizeWidget)
      .filter((w): w is CanvasWidget => w !== null)
      .slice(0, MAX_WIDGETS)
    const camera = raw.camera && isNum(raw.camera.x) && isNum(raw.camera.y) && isNum(raw.camera.zoom)
      ? { x: raw.camera.x, y: raw.camera.y, zoom: Math.min(4, Math.max(0.2, raw.camera.zoom)) }
      : { x: 0, y: 0, zoom: 1 }
    this.snapshot = { widgets, camera, strokes: sanitizeStrokes(raw.strokes) }
    return this.snapshot
  }

  save(snapshot: CanvasSnapshot): void {
    const widgets = (Array.isArray(snapshot.widgets) ? snapshot.widgets : [])
      .map(sanitizeWidget)
      .filter((w): w is CanvasWidget => w !== null)
      .slice(0, MAX_WIDGETS)
    const camera = snapshot.camera && isNum(snapshot.camera.x) && isNum(snapshot.camera.y) && isNum(snapshot.camera.zoom)
      ? { x: snapshot.camera.x, y: snapshot.camera.y, zoom: Math.min(4, Math.max(0.2, snapshot.camera.zoom)) }
      : { x: 0, y: 0, zoom: 1 }
    this.snapshot = { widgets, camera, strokes: sanitizeStrokes(snapshot.strokes) }
    try {
      writeJsonAtomic(this.file, this.snapshot)
    } catch (err) {
      // Layout persistence is best-effort; a read-only profile must not crash.
      console.error('failed to persist canvas layout', err)
    }
  }
}

function emptySnapshot(): CanvasSnapshot {
  return { widgets: [], camera: { x: 0, y: 0, zoom: 1 }, strokes: [] }
}
