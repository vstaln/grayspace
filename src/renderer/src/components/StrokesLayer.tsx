import React, { useLayoutEffect, useRef } from 'react'
import { Camera, Point, Stroke } from '../types'
import { DRAW_CLICK_THRESHOLD_PX } from '../lib/canvasMetrics'

interface Props {
  strokes: Stroke[]
  camera: Camera
  width: number
  height: number
}

interface StrokeMetrics {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Squared distance from the stroke's first point to its farthest point —
   *  exactly what the "did this stroke actually move?" gate needs, without a
   *  second full walk of the points on every frame. */
  spreadSquared: number
}

/**
 * Per-stroke geometry, computed once per stroke revision.
 * Keyed by `${stroke.id}:${stroke.points.length}` so IPC deserialized snapshots
 * with new object identities still hit the cache.
 */
const metricsCache = new Map<string, StrokeMetrics>()
const MAX_METRICS_CACHE_ENTRIES = 5000

function metricsOf(stroke: Stroke): StrokeMetrics {
  const cacheKey = `${stroke.id}:${stroke.points.length}`
  const cached = metricsCache.get(cacheKey)
  if (cached) return cached
  const pts = stroke.points
  const first = pts[0]
  let minX = first.x
  let maxX = first.x
  let minY = first.y
  let maxY = first.y
  let spreadSquared = 0
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i]
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
    const dx = p.x - first.x
    const dy = p.y - first.y
    const d = dx * dx + dy * dy
    if (d > spreadSquared) spreadSquared = d
  }
  const metrics = { minX, minY, maxX, maxY, spreadSquared }
  if (metricsCache.size >= MAX_METRICS_CACHE_ENTRIES) {
    const oldestKey = metricsCache.keys().next().value
    if (oldestKey) metricsCache.delete(oldestKey)
  }
  metricsCache.set(cacheKey, metrics)
  return metrics
}

/**
 * Ink layer, drawn on a plain 2D canvas instead of one `<polyline>` per
 * stroke. A pencil stroke can run to thousands of points, and every pan/zoom
 * frame used to mean rebuilding that many-point path string and handing it to
 * the DOM; a canvas redraw walks the same points straight into `lineTo` calls
 * with no DOM diffing and no string allocation (PERF-ink).
 *
 * Unlike ConnectionsLayer this carries no animation, so it isn't nested in
 * the world div's CSS transform — it owns a full-viewport canvas and applies
 * the camera transform itself, which is what makes the constant-screen-width
 * stroke below possible (a CSS `scale()` on the canvas element would scale
 * the already-rasterised line, not just its path).
 *
 * Two things keep a pan smooth on a heavily drawn canvas, where the stroke
 * store can hold 200,000 points:
 *
 *  - **Culling.** Only strokes whose bounding box overlaps the viewport are
 *    walked at all. Panning away from a drawing used to keep re-walking every
 *    point of it, forever, for pixels that were never on screen.
 *  - **Level of detail.** Zoomed out, consecutive points collapse into the
 *    same device pixel; emitting a `lineTo` per point there is work the
 *    rasteriser throws away. Points closer than half a device pixel to the
 *    last emitted one are skipped, which is invisible by construction and, at
 *    zoom 0.2, drops most of the path.
 */
function StrokesLayer({ strokes, camera, width, height }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Layout effect, not a passive one: the widget layer is positioned by a CSS
  // transform that lands in the same paint as the commit, while a passive
  // effect runs *after* that paint. The ink was therefore always showing the
  // previous frame's camera, so during a pan the drawing visibly slid a frame
  // behind the widgets it was drawn around (CANV-ink-lag).
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    // Assigning width/height reallocates the backing store and clears it, so it
    // only happens when the size actually changed. Doing it unconditionally
    // meant every pan and zoom frame threw away and re-created a full-viewport
    // buffer — on a Retina display that is a 4x-pixel allocation per frame
    // (PERF-ink-realloc).
    const pixelWidth = Math.round(width * dpr)
    const pixelHeight = Math.round(height * dpr)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.translate(camera.x, camera.y)
    const zoom = camera.zoom || 1
    ctx.scale(zoom, zoom)
    // Ink stays a constant 3 screen px at any zoom (matches the old
    // `vector-effect="non-scaling-stroke"` SVG behaviour, CANV-10) — the
    // scale above would otherwise inflate/deflate it with the camera.
    const lineWidth = 3 / zoom
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // The visible world rectangle, grown by a stroke width so a line whose
    // centre sits just outside the viewport still paints the half of it that
    // reaches in.
    const pad = lineWidth
    const viewMinX = (0 - camera.x) / zoom - pad
    const viewMinY = (0 - camera.y) / zoom - pad
    const viewMaxX = (width - camera.x) / zoom + pad
    const viewMaxY = (height - camera.y) / zoom + pad

    // Ignore tiny accidental marks, including stale marks restored from an
    // earlier session. The bound mirrors the draw tool's persistence gate
    // exactly (screen px / zoom = world px), so anything saved to disk also
    // paints — a stricter filter here produced strokes that were persisted
    // but never visible (UI-audit P1).
    const minMovement = DRAW_CLICK_THRESHOLD_PX / zoom
    const minMovementSquared = minMovement * minMovement
    // Half a device pixel, expressed in world units: below this a point cannot
    // change which pixel the line passes through.
    const minStep = 0.5 / (zoom * dpr)
    const minStepSquared = minStep * minStep

    for (const stroke of strokes) {
      const pts = stroke.points
      if (pts.length < 2) continue
      const m = metricsOf(stroke)
      // A pointer click can leave two identical samples behind when the
      // pointer is released before the first animation-frame batch runs.
      // Canvas renders that zero-length path as a stray dot/rectangle.
      if (m.spreadSquared < minMovementSquared) continue
      if (m.maxX < viewMinX || m.minX > viewMaxX || m.maxY < viewMinY || m.minY > viewMaxY) continue

      ctx.strokeStyle = stroke.color
      ctx.beginPath()
      // Indexed walk, not `[first, ...rest]`: the spread copied every point of
      // every stroke into a throwaway array on each redraw frame, and a long
      // drawing made pan/zoom allocate hundreds of thousands of numbers per
      // frame just to draw a path (PERF-ink-alloc).
      let lastX = pts[0].x
      let lastY = pts[0].y
      ctx.moveTo(lastX, lastY)
      const last = pts.length - 1
      for (let i = 1; i < last; i += 1) {
        const p: Point = pts[i]
        const dx = p.x - lastX
        const dy = p.y - lastY
        if (dx * dx + dy * dy < minStepSquared) continue
        ctx.lineTo(p.x, p.y)
        lastX = p.x
        lastY = p.y
      }
      // The final point is always emitted: dropping it would visibly shorten
      // the stroke the user is drawing right now.
      ctx.lineTo(pts[last].x, pts[last].y)
      ctx.stroke()
    }
  }, [strokes, camera.x, camera.y, camera.zoom, width, height])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      style={{ width, height }}
      aria-hidden
    />
  )
}

export default React.memo(StrokesLayer)
