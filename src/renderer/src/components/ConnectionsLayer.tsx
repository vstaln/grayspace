import React, { useEffect, useMemo, useState } from 'react'
import { Connection, Widget } from '../types'

interface Props {
  connections: Connection[]
  widgets: Widget[]
}

/** Anchor point: the middle of a widget's header, in world coordinates. */
function anchor(w: Widget): { x: number; y: number } {
  return { x: w.x + w.w / 2, y: w.y }
}

/**
 * A quadratic arc bowed upward between two points — the same shape the
 * reference sketch uses, like a cable slung between two poles rather than a
 * straight wire.
 */
function arcPath(a: { x: number; y: number }, b: { x: number; y: number }): { d: string; midX: number; midY: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dist = Math.hypot(dx, dy)
  // The bow is proportional to the span so a short hop and a cross-canvas link
  // both read as the same kind of curve rather than one looking like a spike.
  const bow = Math.min(120, Math.max(24, dist * 0.22))
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2 - bow
  return { d: `M ${a.x} ${a.y} Q ${midX} ${midY} ${b.x} ${b.y}`, midX, midY }
}

/** How long the brighter "just connected" flare plays before settling. */
const FLARE_MS = 1600

/**
 * Lit arcs between an agent's terminal and the ones it opened — the only
 * visible record of "this shell spawned that one" once both are just windows
 * side by side on the canvas. A freshly opened link flares brighter and runs
 * a dot along the curve once; every link keeps a faint, slow shimmer after
 * that so a canvas full of terminals still reads as a tree.
 */
function ConnectionsLayer({ connections, widgets }: Props): React.JSX.Element | null {
  // No links on the canvas is the common case, and `widgets` gets a fresh
  // array identity on every drag/resize frame — building a 200-entry lookup
  // map per frame for a layer that draws nothing is pure overhead. Bail before
  // the map, and before the <svg>/<filter> subtree exists at all.
  const hasConnections = connections.length > 0
  const byId = useMemo(
    () => (hasConnections ? new Map(widgets.map((w) => [w.id, w])) : new Map<string, Widget>()),
    [hasConnections, widgets]
  )
  if (!hasConnections) return null

  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" style={{ width: 1, height: 1 }}>
      <defs>
        <filter id="conn-blur" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {connections.map((c) => {
        const from = byId.get(c.from)
        const to = byId.get(c.to)
        if (!from || !to || from.id === to.id || from.maximized || to.maximized) return null
        const { d } = arcPath(anchor(from), anchor(to))
        return <ConnectionArc key={c.id} d={d} bornAt={c.bornAt} />
      })}
    </svg>
  )
}

export default React.memo(ConnectionsLayer)

function ConnectionArc({ d, bornAt }: { d: string; bornAt: number }): React.JSX.Element {
  // Local timer rather than a prop computed by the parent: the flare has to
  // turn itself off a moment after it starts, and nothing else in this app
  // re-renders the canvas on a plain interval to notice that for it.
  const [fresh, setFresh] = useState(() => Date.now() - bornAt < FLARE_MS)
  useEffect(() => {
    if (!fresh) return
    const remaining = FLARE_MS - (Date.now() - bornAt)
    const timer = setTimeout(() => setFresh(false), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [bornAt, fresh])

  return (
    <g className={fresh ? 'conn-arc conn-arc-fresh' : 'conn-arc'}>
      {/* Resting thread: a thin, steady line so the relationship is visible
          even long after the flare has played. */}
      <path d={d} className="conn-thread" fill="none" />
      {/* The glow pass — wider, blurred, brighter while fresh. */}
      <path d={d} className="conn-glow" fill="none" filter="url(#conn-blur)" />
      {/* A single point of light travelling the arc once on arrival. Finite
          animations only: an `repeatCount="indefinite"` shimmer here used to
          keep the compositor animating every link on the canvas forever, a
          constant GPU/CPU tax for decoration nobody watches after the first
          second (PERF-conn-idle). The resting thread below carries the
          relationship once the flare has played. */}
      {fresh && (
        <circle r="3.2" className="conn-flare-dot" fill="#ffffff">
          <animateMotion dur="1.1s" begin="0s" fill="freeze" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.22 0.61 0.36 1" />
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.75;1" dur="1.1s" fill="freeze" />
        </circle>
      )}
    </g>
  )
}
