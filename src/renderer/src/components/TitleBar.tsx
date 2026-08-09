import React, { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'

export default function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
    return window.api.window.onMaximizeChange(setMaximized)
  }, [])

  // Without an explicit z-index the positioned `<main>` paints over this bar
  // (the rail does the same).
  return (
    <div className="pointer-events-none absolute top-0 right-0 z-[1000] flex h-8 items-center">
      <div
        className="pointer-events-auto flex h-8 items-center rounded-bl-lg border-b border-l border-line-soft bg-bg-panel/80 shadow-sm glass:bg-bg-panel/75 glass:backdrop-blur-xl"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          className="grid h-full w-9 place-items-center text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
          title="Свернуть"
          aria-label="Свернуть"
          onClick={() => window.api.window.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          className="grid h-full w-9 place-items-center text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
          title={maximized ? 'Восстановить' : 'Развернуть'}
          aria-label={maximized ? 'Восстановить' : 'Развернуть'}
          onClick={() => window.api.window.toggleMaximize()}
        >
          {maximized ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          className="grid h-full w-10 place-items-center text-text-dim transition-colors hover:bg-[#e04343] hover:text-white"
          title="Закрыть"
          aria-label="Закрыть"
          onClick={() => window.api.window.close()}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  )
}
