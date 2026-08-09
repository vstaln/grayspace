import React from 'react'
import { Stroke } from '../types'

interface Props {
  strokes: Stroke[]
}

export default function StrokesLayer({ strokes }: Props): React.JSX.Element {
  return (
    <svg
      className="pointer-events-none absolute inset-0 overflow-visible"
      style={{ width: 1, height: 1 }}
    >
      {strokes.map((s) => (
        <polyline
          key={s.id}
          points={s.points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={s.color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}
