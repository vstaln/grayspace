import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Minus, Plus, X } from 'lucide-react'
import type { BrainGraph as GraphData } from '../../../preload/index.d'

interface Props {
  graph: GraphData
  selectedId: string | null
  /** Fired on a click that was not a drag — opens the note. */
  onOpen(id: string): void
  /** Full-screen mode: no chrome but the corner controls, no bottom bar. */
  fullscreen?: boolean
  /** Leaves the graph. Rendered as the last button in the top-right corner. */
  onExit?(): void
}

interface Body {
  id: string
  title: string
  degree: number
  x: number
  y: number
  vx: number
  vy: number
  /** Radius in world units; grows with how connected the note is. */
  r: number
  /** 0→1 fade-in so new nodes appear rather than pop. */
  alpha: number
  /** Note's accent colour; falls back to white when unset. */
  color?: string
}

// Force constants, tuned for a few hundred notes on a 60fps loop.
const REPULSION = 5200
const SPRING = 0.012
const SPRING_LENGTH = 118
const CENTER_PULL = 0.006
const DAMPING = 0.9
const MAX_SPEED = 12
const CLICK_SLOP = 4

/** Shared look for the corner controls — glassy, quiet, same size. */
const GRAPH_BUTTON =
  'grid h-8 w-8 place-items-center rounded-[10px] border border-white/10 bg-black/40 text-text backdrop-blur-md transition-colors hover:bg-white/10'

/**
 * Force-directed knowledge graph drawn on a canvas: notes are white dots,
 * links are thin grey lines. Physics runs only while the layout is still
 * settling (or while dragging), so an idle panel costs no CPU.
 */
export default function BrainGraph({ graph, selectedId, onOpen, fullscreen = false, onExit }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const bodies = useRef<Map<string, Body>>(new Map())
  const camera = useRef({ x: 0, y: 0, zoom: 1 })
  const pointer = useRef<{ hoverId: string | null; dragId: string | null }>({ hoverId: null, dragId: null })
  const frame = useRef(0)
  const energy = useRef(1)
  const [hoverTitle, setHoverTitle] = useState<string | null>(null)

  const edges = useMemo(
    () => graph.edges.filter(e => graph.nodes.some(n => n.id === e.source) && graph.nodes.some(n => n.id === e.target)),
    [graph]
  )

  // ---- bodies are kept across renders so the layout survives note edits ----
  useEffect(() => {
    const next = new Map<string, Body>()
    const count = Math.max(graph.nodes.length, 1)
    graph.nodes.forEach((node, i) => {
      const existing = bodies.current.get(node.id)
      if (existing) {
        next.set(node.id, { ...existing, title: node.title, degree: node.degree, r: radiusFor(node.degree), color: node.color })
        return
      }
      // Seed on a circle: a ring untangles far faster than random placement.
      const angle = (i / count) * Math.PI * 2
      next.set(node.id, {
        id: node.id,
        title: node.title,
        degree: node.degree,
        x: Math.cos(angle) * (90 + count * 4),
        y: Math.sin(angle) * (90 + count * 4),
        vx: 0,
        vy: 0,
        r: radiusFor(node.degree),
        alpha: 0,
        color: node.color
      })
    })
    bodies.current = next
    energy.current = 1 // re-heat so the layout reflows around the change
  }, [graph.nodes])

  // ---- simulation + render loop ------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = wrap.clientWidth * dpr
      canvas.height = wrap.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    const step = (): void => {
      const list = Array.from(bodies.current.values())
      const settling = energy.current > 0.02 || pointer.current.dragId
      if (settling) {
        simulate(list, edges, pointer.current.dragId)
        energy.current *= 0.985
      }
      for (const body of list) if (body.alpha < 1) body.alpha = Math.min(1, body.alpha + 0.06)
      draw(ctx, wrap, list, edges, camera.current, selectedId, pointer.current.hoverId)
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(frame.current)
      observer.disconnect()
    }
  }, [edges, selectedId])

  // ---- pointer: hover, node drag, camera pan ------------------------------
  const toWorld = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = wrapRef.current?.getBoundingClientRect()
    const cam = camera.current
    const cx = clientX - (rect?.left ?? 0) - (rect?.width ?? 0) / 2
    const cy = clientY - (rect?.top ?? 0) - (rect?.height ?? 0) / 2
    return { x: (cx - cam.x) / cam.zoom, y: (cy - cam.y) / cam.zoom }
  }, [])

  const hit = useCallback(
    (clientX: number, clientY: number): Body | null => {
      const { x, y } = toWorld(clientX, clientY)
      let found: Body | null = null
      for (const body of bodies.current.values()) {
        const grab = Math.max(body.r + 6, 12)
        if ((body.x - x) ** 2 + (body.y - y) ** 2 <= grab * grab) found = body
      }
      return found
    },
    [toWorld]
  )

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const target = hit(e.clientX, e.clientY)
    const start = { x: e.clientX, y: e.clientY }
    const origin = { ...camera.current }
    let moved = 0

    if (target) pointer.current.dragId = target.id

    const onMove = (ev: MouseEvent): void => {
      moved = Math.max(moved, Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y))
      if (target) {
        // Pin the node under the cursor; the rest of the graph reacts to it.
        const world = toWorld(ev.clientX, ev.clientY)
        target.x = world.x
        target.y = world.y
        target.vx = 0
        target.vy = 0
        energy.current = Math.max(energy.current, 0.5)
      } else {
        camera.current = { ...origin, x: origin.x + (ev.clientX - start.x), y: origin.y + (ev.clientY - start.y) }
      }
    }

    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      pointer.current.dragId = null
      // A press that never travelled is a click: open the note.
      if (target && moved < CLICK_SLOP && Math.abs(ev.clientX - start.x) < CLICK_SLOP) onOpen(target.id)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onMouseMove = (e: React.MouseEvent): void => {
    if (pointer.current.dragId) return
    const target = hit(e.clientX, e.clientY)
    pointer.current.hoverId = target?.id ?? null
    setHoverTitle(target?.title ?? null)
  }

  const onWheel = (e: React.WheelEvent): void => {
    const cam = camera.current
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const zoom = Math.min(3.5, Math.max(0.25, cam.zoom * factor))
    const rect = wrapRef.current?.getBoundingClientRect()
    const px = e.clientX - (rect?.left ?? 0) - (rect?.width ?? 0) / 2
    const py = e.clientY - (rect?.top ?? 0) - (rect?.height ?? 0) / 2
    // Keep the point under the cursor fixed while zooming.
    camera.current = {
      zoom,
      x: px - ((px - cam.x) / cam.zoom) * zoom,
      y: py - ((py - cam.y) / cam.zoom) * zoom
    }
  }

  const zoomBy = (factor: number): void => {
    const cam = camera.current
    camera.current = { ...cam, zoom: Math.min(3.5, Math.max(0.25, cam.zoom * factor)) }
  }

  /** Frames every node: fits the bounding box of the current layout. */
  const fit = (): void => {
    const list = Array.from(bodies.current.values())
    const wrap = wrapRef.current
    if (!list.length || !wrap) return
    const xs = list.map(b => b.x)
    const ys = list.map(b => b.y)
    const width = Math.max(...xs) - Math.min(...xs) + 140
    const height = Math.max(...ys) - Math.min(...ys) + 140
    const zoom = Math.min(2, Math.max(0.25, Math.min(wrap.clientWidth / width, wrap.clientHeight / height)))
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2
    camera.current = { zoom, x: -cx * zoom, y: -cy * zoom }
  }

  return (
    <div
      ref={wrapRef}
      className={`brain-graph-surface relative flex-1 min-h-0 overflow-hidden ${pointer.current.dragId ? 'cursor-grabbing' : 'cursor-grab'}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => { pointer.current.hoverId = null; setHoverTitle(null) }}
      onWheel={onWheel}
    >
      <canvas ref={canvasRef} className="block h-full w-full" role="img" aria-label={`Граф заметок: ${graph.nodes.length} узлов, ${edges.length} связей`} />

      {/* One cluster of controls, bottom right — out of the way of the window
          buttons and anything else that lives along the top edge. In full
          screen it is the only chrome here, so it fades back until the pointer
          comes near. */}
      <div className={`absolute bottom-4 right-4 flex gap-1.5 transition-opacity duration-300 ${fullscreen ? 'opacity-35 hover:opacity-100' : ''}`}>
        <button className={GRAPH_BUTTON} title="Приблизить" onClick={() => zoomBy(1.2)}>
          <Plus size={14} />
        </button>
        <button className={GRAPH_BUTTON} title="Отдалить" onClick={() => zoomBy(1 / 1.2)}>
          <Minus size={14} />
        </button>
        <button className={GRAPH_BUTTON} title="Вписать в экран" onClick={fit}>
          <Crosshair size={14} />
        </button>
        {onExit && (
          <button
            className={`${GRAPH_BUTTON} ml-1 hover:border-white/30 hover:bg-white/10`}
            title="Выйти из графа (Esc)"
            onClick={onExit}
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* The bottom bar is a hint for someone still learning the panel, so it
          is off in full screen — the point there is the graph and nothing
          else. The hovered title floats over the canvas instead. */}
      {!fullscreen && (
        <div className="pointer-events-none absolute bottom-3 left-3.5 rounded-[10px] border border-line-soft bg-bg/80 px-2.5 py-1.5 text-[11px] text-text-faint">
          {hoverTitle ? <b>{hoverTitle}</b> : `${graph.nodes.length} заметок · ${edges.length} связей`}
          {!hoverTitle && ' · клик по точке открывает заметку, колесо — масштаб'}
        </div>
      )}
    </div>
  )
}

/**
 * More connections → slightly bigger dot, capped so hubs stay tasteful.
 *
 * Deliberately small: at the old sizes a few dozen notes read as a scatter of
 * blobs, and the graph's shape — which is the only thing a knowledge graph is
 * for — got lost behind the dots drawing it. A star, not a bead.
 */
function radiusFor(degree: number): number {
  return Math.min(5.2, 1.9 + Math.sqrt(degree) * 0.85)
}

/** One physics tick: repulsion between all pairs, springs along edges, gentle centring. */
function simulate(list: Body[], edges: GraphData['edges'], dragId: string | null): void {
  // PERF-007: the repulsion force falls off as 1/dist² and is negligible
  // beyond ~two cells, so bin the bodies into a grid and only evaluate pairs
  // in neighbouring cells. An all-pairs scan was O(n²); typical layouts
  // (a few dozen visible notes) now stay linear in practice.
  const CELL = 200
  const bins = new Map<string, Body[]>()
  for (const body of list) {
    const key = `${Math.floor(body.x / CELL)},${Math.floor(body.y / CELL)}`
    let cell = bins.get(key)
    if (!cell) {
      cell = []
      bins.set(key, cell)
    }
    cell.push(body)
  }
  const nearby = (body: Body): Body[] => {
    const cx = Math.floor(body.x / CELL)
    const cy = Math.floor(body.y / CELL)
    const out: Body[] = []
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1) {
        const cell = bins.get(`${cx + dx},${cy + dy}`)
        if (cell) for (const other of cell) if (other !== body) out.push(other)
      }
    return out
  }

  for (const body of list) {
    let fx = -body.x * CENTER_PULL
    let fy = -body.y * CENTER_PULL

    for (const other of nearby(body)) {
      const dx = body.x - other.x
      const dy = body.y - other.y
      // Floor the distance so co-located nodes get a finite, stable push apart.
      const distSq = Math.max(dx * dx + dy * dy, 60)
      const force = REPULSION / distSq
      const dist = Math.sqrt(distSq)
      fx += (dx / dist) * force
      fy += (dy / dist) * force
    }

    body.vx = (body.vx + fx) * DAMPING
    body.vy = (body.vy + fy) * DAMPING
  }

  const byId = new Map(list.map(b => [b.id, b]))
  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.max(Math.hypot(dx, dy), 1)
    // Tag edges pull more softly than explicit links.
    const stiffness = edge.kind === 'tag' ? SPRING * 0.45 : SPRING
    const force = (dist - SPRING_LENGTH) * stiffness
    const ux = (dx / dist) * force
    const uy = (dy / dist) * force
    a.vx += ux
    a.vy += uy
    b.vx -= ux
    b.vy -= uy
  }

  for (const body of list) {
    if (body.id === dragId) continue
    body.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, body.vx))
    body.vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, body.vy))
    body.x += body.vx
    body.y += body.vy
  }
}

function draw(
  ctx: CanvasRenderingContext2D,
  wrap: HTMLDivElement,
  list: Body[],
  edges: GraphData['edges'],
  camera: { x: number; y: number; zoom: number },
  selectedId: string | null,
  hoverId: string | null
): void {
  const width = wrap.clientWidth
  const height = wrap.clientHeight
  ctx.clearRect(0, 0, width, height)
  drawBackground(ctx, width, height, camera)
  ctx.save()
  ctx.translate(width / 2 + camera.x, height / 2 + camera.y)
  ctx.scale(camera.zoom, camera.zoom)

  const byId = new Map(list.map(b => [b.id, b]))
  // Hover only. The selected note used to count as "active" too, so whichever
  // note happened to be open in the list sat permanently brighter than the
  // rest with its caption always on — it read as one node glowing for no
  // reason. Emphasis now appears only under the pointer.
  const active = hoverId
  const neighbours = new Set<string>()
  if (active)
    for (const edge of edges) {
      if (edge.source === active) neighbours.add(edge.target)
      if (edge.target === active) neighbours.add(edge.source)
    }

  // ---- edges: thin, mostly transparent, brighter around the active node ---
  ctx.lineWidth = 1 / camera.zoom
  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (!a || !b) continue
    const touches = active === edge.source || active === edge.target
    const alpha = Math.min(a.alpha, b.alpha) * (touches ? 0.55 : edge.kind === 'tag' ? 0.1 : 0.18)
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  // ---- nodes --------------------------------------------------------------
  // Small, plain white discs. Rings mark hover and selection; nothing glows.
  for (const body of list) {
    const isActive = body.id === active
    const related = !active || isActive || neighbours.has(body.id)
    const alpha = body.alpha * (related ? 1 : 0.75)
    const r = body.r

    // A plain white disc — no colour, no glow, no ring. Nodes unrelated to the
    // one under the pointer fade back only slightly: at the old 0.22 they went
    // properly grey and looked broken, so the focus is a hint rather than a
    // spotlight.
    ctx.beginPath()
    ctx.arc(body.x, body.y, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255,255,255,${alpha})`
    ctx.fill()

    // Labels would be noise on a dense zoomed-out graph.
    if (camera.zoom > 0.55 || isActive) {
      ctx.font = `${(isActive ? 11.5 : 10.5) / camera.zoom}px Inter, "Segoe UI", system-ui, sans-serif`
      ctx.textAlign = 'center'
      // A soft black shadow keeps the caption legible over a bright star.
      ctx.shadowColor = 'rgba(0,0,0,0.85)'
      ctx.shadowBlur = 4 / camera.zoom
      ctx.fillStyle = `rgba(226,230,238,${alpha * (isActive ? 1 : 0.55)})`
      ctx.fillText(truncate(body.title), body.x, body.y + r + 12 / camera.zoom)
      ctx.shadowBlur = 0
    }
  }

  ctx.restore()
}

function truncate(title: string): string {
  return title.length > 26 ? `${title.slice(0, 25)}…` : title
}

/** Deterministic 0..1 pseudo-random from a cell's integer coordinates, so a
 *  star's position/size/brightness stay fixed instead of re-rolling every
 *  frame — the only state a starfield needs is which cells to look at. */
function hash(cx: number, cy: number, seed: number): number {
  let h = (cx * 374761393 + cy * 668265263 + seed * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return ((h >>> 0) % 100000) / 100000
}

interface StarLayer {
  /** World-unit spacing between grid cells a star might occupy. */
  cellSize: number
  /** How strongly this layer tracks the camera — near 0 reads as "far away". */
  parallax: number
  /** Fraction of cells that actually hold a star. */
  density: number
  minR: number
  maxR: number
  minAlpha: number
  maxAlpha: number
  seed: number
}

// Three depths: a dense faint dust of distant stars, a mid layer, and a
// sparse handful of bright near ones — the size/brightness spread plus the
// differing parallax speeds is what reads as depth rather than a flat sprinkle.
const STAR_LAYERS: StarLayer[] = [
  { cellSize: 46, parallax: 0.18, density: 0.5, minR: 0.35, maxR: 0.8, minAlpha: 0.15, maxAlpha: 0.35, seed: 1 },
  { cellSize: 90, parallax: 0.4, density: 0.32, minR: 0.6, maxR: 1.3, minAlpha: 0.25, maxAlpha: 0.55, seed: 2 },
  { cellSize: 170, parallax: 0.7, density: 0.16, minR: 1, maxR: 2, minAlpha: 0.4, maxAlpha: 0.85, seed: 3 }
]

/** A handful of large, very faint grey glows — the "nebula dust" between stars. */
const NEBULAE = [
  { x: -900, y: 500, r: 520, seed: 11 },
  { x: 750, y: -600, r: 460, seed: 12 },
  { x: 1500, y: 700, r: 600, seed: 13 },
  { x: -1600, y: -750, r: 500, seed: 14 }
]

function drawStarLayer(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: { x: number; y: number; zoom: number },
  layer: StarLayer
): void {
  const scale = 1 + (camera.zoom - 1) * layer.parallax
  const originX = width / 2 + camera.x * layer.parallax
  const originY = height / 2 + camera.y * layer.parallax
  const toWorld = (sx: number, sy: number): [number, number] => [(sx - originX) / scale, (sy - originY) / scale]
  const [left, top] = toWorld(0, 0)
  const [right, bottom] = toWorld(width, height)

  const c = layer.cellSize
  const x0 = Math.floor(left / c) - 1
  const x1 = Math.ceil(right / c) + 1
  const y0 = Math.floor(top / c) - 1
  const y1 = Math.ceil(bottom / c) + 1

  for (let gx = x0; gx <= x1; gx += 1)
    for (let gy = y0; gy <= y1; gy += 1) {
      const present = hash(gx, gy, layer.seed)
      if (present >= layer.density) continue
      const jx = hash(gx, gy, layer.seed + 100)
      const jy = hash(gx, gy, layer.seed + 200)
      const wx = (gx + jx) * c
      const wy = (gy + jy) * c
      const sx = originX + wx * scale
      const sy = originY + wy * scale
      const t = hash(gx, gy, layer.seed + 300)
      const r = (layer.minR + t * (layer.maxR - layer.minR)) * Math.max(0.6, scale)
      const alpha = layer.minAlpha + hash(gx, gy, layer.seed + 400) * (layer.maxAlpha - layer.minAlpha)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255,255,255,${alpha})`
      ctx.fill()
    }
}

function drawNebulae(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: { x: number; y: number; zoom: number }
): void {
  const parallax = 0.12
  const scale = 1 + (camera.zoom - 1) * parallax
  const originX = width / 2 + camera.x * parallax
  const originY = height / 2 + camera.y * parallax
  for (const n of NEBULAE) {
    const sx = originX + n.x * scale
    const sy = originY + n.y * scale
    const r = n.r * scale
    if (sx + r < 0 || sx - r > width || sy + r < 0 || sy - r > height) continue
    const alpha = 0.05 + hash(n.seed, 0, 5) * 0.035
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
    glow.addColorStop(0, `rgba(255,255,255,${alpha})`)
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = glow
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2)
  }
}

/**
 * A grayscale "galaxy": a black base, a few soft nebula glows, three star
 * layers panning at different speeds for a light parallax sense of depth, and
 * a screen-space vignette darkening the edges. Every colour here is a shade
 * of grey on purpose — no tint, warm or cool, is allowed to creep in.
 */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: { x: number; y: number; zoom: number }
): void {
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)

  drawNebulae(ctx, width, height, camera)
  for (const layer of STAR_LAYERS) drawStarLayer(ctx, width, height, camera, layer)

  // Vignette stays anchored to the viewport, not the world, so it reads as an
  // edge-darkening lens effect no matter where the camera has panned to.
  const cx = width / 2
  const cy = height / 2
  const radius = Math.max(width, height) * 0.72
  const vignette = ctx.createRadialGradient(cx, cy, radius * 0.35, cx, cy, radius)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.65)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, width, height)
}
