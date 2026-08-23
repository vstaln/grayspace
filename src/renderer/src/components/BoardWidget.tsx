import React, { Suspense, lazy } from 'react'
import { useCoordination } from '../hooks/useCoordination'
import { useConfirm } from './ConfirmDialog'

// Same async chunk App's full-screen board uses. A static import here would
// drag KanbanBoard back into the startup bundle and defeat the split
// (PERF-lazy-surfaces).
const KanbanBoard = lazy(() => import('./KanbanBoard'))

/**
 * The kanban board as a canvas widget: draggable, resizable and left open
 * beside the terminals it describes, instead of a modal that covers them.
 *
 * It subscribes to the coordination store itself rather than taking a snapshot
 * as a prop — several boards can be on the canvas at once, and each one should
 * be live without App having to know how many exist.
 */
export default function BoardWidget(): React.JSX.Element {
  const coordination = useCoordination()
  const confirm = useConfirm()

  return (
    <Suspense fallback={null}>
      <KanbanBoard
      embedded
      snapshot={coordination.snapshot}
      onCreate={(title, brief) => coordination.createTask(title, brief)}
      onMove={(id, state) => coordination.moveTask(id, state)}
      onDelete={(id) => coordination.deleteTask(id)}
      onResetManager={() => {
        return confirm('Reset lead role? Any agent will be able to claim it again.').then((ok) => {
          return ok ? coordination.resetManager() : { ok: true }
        })
      }}
      onReleaseLocks={() => {
        return confirm('Release all file locks?').then((ok) => {
          return ok ? coordination.releaseLocks() : { ok: true }
        })
      }}
      // The widget frame owns closing; the board's own button is hidden.
      onClose={() => undefined}
      />
    </Suspense>
  )
}
