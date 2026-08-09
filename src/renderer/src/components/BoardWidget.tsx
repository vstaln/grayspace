import React from 'react'
import KanbanBoard from './KanbanBoard'
import { useCoordination } from '../hooks/useCoordination'
import { useConfirm } from './ConfirmDialog'

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
    <KanbanBoard
      embedded
      snapshot={coordination.snapshot}
      onCreate={(title, brief) => void coordination.createTask(title, brief)}
      onMove={(id, state) => void coordination.moveTask(id, state)}
      onDelete={(id) => {
        void confirm('Удалить задачу? Действие необратимо.', { danger: true, confirmLabel: 'Удалить' }).then((ok) => {
          if (ok) void coordination.deleteTask(id)
        })
      }}
      onResetManager={() => {
        void confirm('Сбросить роль руководителя? Любой агент сможет занять её заново.').then((ok) => {
          if (ok) void coordination.resetManager()
        })
      }}
      onReleaseLocks={() => {
        void confirm('Снять все блокировки ресурсов?').then((ok) => {
          if (ok) void coordination.releaseLocks()
        })
      }}
      // The widget frame owns closing; the board's own button is hidden.
      onClose={() => undefined}
    />
  )
}
