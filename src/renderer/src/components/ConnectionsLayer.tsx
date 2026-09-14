import React, { useEffect, useMemo, useState } from 'react'
import { Connection, Widget } from '../types'

interface Props {
  connections: Connection[]
  widgets: Widget[]
}


function anchor(w: Widget): { x: number; y: number } {
  return { x: w.x + w.w / 2, y: w.y }
}






function arcPath(a: { x: number; y: number }, b: { x: number; y: number }): { d: string; midX: number; midY: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dist = Math.hypot(dx, dy)


  const bow = Math.min(120, Math.max(24, dist * 0.22))
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2 - bow
  return { d: `M ${a.x} ${a.y} Q ${midX} ${midY} ${b.x} ${b.y}`, midX, midY }
}


const FLARE_MS = 1600








function ConnectionsLayer({ connections, widgets }: Props): React.JSX.Element | null {
  const hasConnections = connections.length > 0


  const rawId = React.useId()
  const filterId = rawId.replace(/:/g, '')






  // Includes id, so this key alone already captures membership and order —
  // no need for a separate id-only key alongside it.
  const widgetPositionsKey = widgets.map((w) => `${w.id}:${w.x}:${w.y}:${w.w}:${Boolean(w.maximized)}`).join('\n')
  const byId = useMemo(
    () => (hasConnections ? new Map(widgets.map((w) => [w.id, w])) : new Map<string, Widget>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasConnections, widgetPositionsKey]
  )
  if (!hasConnections) return null

  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" style={{ width: 1, height: 1 }}>
      <defs>
        <filter id={`conn-blur-${filterId}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {connections.map((c) => {
        const from = byId.get(c.from)
        const to = byId.get(c.to)
        if (!from || !to || from.id === to.id || from.maximized || to.maximized) return null
        const { d } = arcPath(anchor(from), anchor(to))
        return <ConnectionArc key={c.id} d={d} bornAt={c.bornAt} filterId={filterId} />
      })}
    </svg>
  )
}

export default React.memo(ConnectionsLayer)

function ConnectionArc({ d, bornAt, filterId }: { d: string; bornAt: number; filterId: string }): React.JSX.Element {



  const [fresh, setFresh] = useState(() => Date.now() - bornAt < FLARE_MS)
  useEffect(() => {
    if (!fresh) return
    const remaining = FLARE_MS - (Date.now() - bornAt)
    const timer = setTimeout(() => setFresh(false), Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [bornAt, fresh])

  return (
    <g className={fresh ? 'conn-arc conn-arc-fresh' : 'conn-arc'}>
      {
}
      <path d={d} className="conn-thread" fill="none" />
      {}
      <path d={d} className="conn-glow" fill="none" filter={`url(#conn-blur-${filterId})`} />
      {




}
      {fresh && (
        <circle r="3.2" className="conn-flare-dot" fill="#ffffff">
          <animateMotion dur="1.1s" begin="0s" fill="freeze" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.22 0.61 0.36 1" />
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.75;1" dur="1.1s" fill="freeze" />
        </circle>
      )}
    </g>
  )
}
