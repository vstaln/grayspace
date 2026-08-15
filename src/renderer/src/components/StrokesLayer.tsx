import React, { useMemo } from 'react'
import { Stroke } from '../types'

interface Props {
  strokes: Stroke[]
}

/**
 * Canvas ink layer. Memoized so pan/zoom/widget drag (which re-render App)
 * does not rebuild every polyline string when the stroke list is unchanged.
 */
function StrokesLayer({ strokes }: Props): React.JSX.Element {
  const polylines = useMemo(
    () =>
      strokes.map((s) => ({
        id: s.id,
        color: s.color,
        // One string per stroke; rebuilt only when this stroke's points change.
        points: s.points.map((p) => `${p.x},${p.y}`).join(' ')
      })),
    [strokes]
  )

  return (
    <svg
      className="pointer-events-none absolute inset-0 overflow-visible"
      style={{ width: 1, height: 1 }}
      aria-hidden
    >
      {polylines.map((s) => (
        <polyline
          key={s.id}
          points={s.points}
          fill="none"
          stroke={s.color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          // The world layer is transform: scale(zoom), so a plain strokeWidth
          // would inflate/deflate with the camera. Keep the ink a constant
          // 3 screen px at any zoom (CANV-10).
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

export default React.memo(StrokesLayer)
