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



  spreadSquared: number
}






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


























function StrokesLayer({ strokes, camera, width, height }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)






  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1





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



    const lineWidth = 3 / zoom
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'




    const pad = lineWidth
    const viewMinX = (0 - camera.x) / zoom - pad
    const viewMinY = (0 - camera.y) / zoom - pad
    const viewMaxX = (width - camera.x) / zoom + pad
    const viewMaxY = (height - camera.y) / zoom + pad






    const minMovement = DRAW_CLICK_THRESHOLD_PX / zoom
    const minMovementSquared = minMovement * minMovement


    const minStep = 0.5 / (zoom * dpr)
    const minStepSquared = minStep * minStep

    for (const stroke of strokes) {
      const pts = stroke.points
      if (pts.length < 2) continue
      const m = metricsOf(stroke)



      if (m.spreadSquared < minMovementSquared) continue
      if (m.maxX < viewMinX || m.minX > viewMaxX || m.maxY < viewMinY || m.minY > viewMaxY) continue

      ctx.strokeStyle = stroke.color
      ctx.beginPath()




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
