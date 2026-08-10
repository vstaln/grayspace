import React from 'react'

/** No free-licensed Codex/OpenAI mark exists to fetch, so this is a plain monochrome glyph. */
export default function CodexIcon({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#ffffff" />
      <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13.5 7l-3 10" stroke="#111111" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
