import React, { useEffect, useRef } from 'react'
import { Camera, Stroke } from '../types'

interface Props {
  strokes: Stroke[]
  camera: Camera
  width: number
  height: number
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
 */
function StrokesLayer({ strokes, camera, width, height }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.translate(camera.x, camera.y)
    const zoom = camera.zoom || 1
    ctx.scale(zoom, zoom)
    // Ink stays a constant 3 screen px at any zoom (matches the old
    // `vector-effect="non-scaling-stroke"` SVG behaviour, CANV-10) — the
    // scale above would otherwise inflate/deflate it with the camera.
    ctx.lineWidth = 3 / zoom
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const stroke of strokes) {
      if (stroke.points.length < 2) continue
      ctx.strokeStyle = stroke.color
      ctx.beginPath()
      // Indexed walk, not `[first, ...rest]`: the spread copied every point of
      // every stroke into a throwaway array on each redraw frame, and a long
      // drawing made pan/zoom allocate hundreds of thousands of numbers per
      // frame just to draw a path (PERF-ink-alloc).
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
      for (let i = 1; i < stroke.points.length; i += 1) ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
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
