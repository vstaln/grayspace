import React from 'react'

export interface VerifiedBadgeProps {
  size?: number
  className?: string
  style?: React.CSSProperties
  title?: string
}

/**
 * Blue verified checkmark badge.
 */
export function VerifiedBadge({
  size = 15,
  className = '',
  style = {},
  title = 'Verified'
}: VerifiedBadgeProps): React.JSX.Element {
  return (
    <svg
      className={`inline-block flex-none select-none ${className}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{
        fill: '#38bdf8',
        verticalAlign: '-2px',
        ...style
      }}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91c-1.31.67-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.33c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.66 1.31 1.91 2.19 3.33 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.66 2.19-1.9 2.19-3.33zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-4.8 1.41 1.42z" />
    </svg>
  )
}

export default VerifiedBadge
