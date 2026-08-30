import type { CoordinationStore, Task } from './coordination.ts'
import type { PlannerStore, PlanItem } from './plannerStore.ts'

/**
 * Live bidirectional synchronization between PlannerStore and CoordinationStore.
 *
 * Keeps personal plan outline and kanban board tasks in sync:
 * - Creating or updating a task in Planner reflects on Kanban Board.
 * - Changing task state on Kanban Board (or an agent claiming/completing via CLI)
 *   updates completion status in Planner.
 * - Deletions and edits on either side propagate to the other.
 */
export function initPlannerSync(planner: PlannerStore, coordination: CoordinationStore): () => void {
  let isSyncing = false

  const syncPlanItemToBoard = (item: PlanItem): void => {
    const task = coordination.task(item.id)
    const desiredTags = item.project ? [item.project] : []
    if (!task) {
      coordination.createTask({
        id: item.id,
        title: item.title,
        brief: item.note,
        state: item.done ? 'done' : 'queued',
        tags: desiredTags,
        createdBy: item.createdBy || 'user'
      })
    } else {
      const desiredState = item.done ? 'done' : (task.state === 'done' ? 'queued' : task.state)
      const desiredTitle = item.title
      const desiredBrief = item.note || ''
      const tagsChanged = JSON.stringify(task.tags || []) !== JSON.stringify(desiredTags)

      if (task.state !== desiredState || task.title !== desiredTitle || (task.brief || '') !== desiredBrief || tagsChanged) {
        coordination.updateTaskAsUser(
          item.id,
          {
            state: desiredState,
            title: desiredTitle,
            brief: desiredBrief,
            tags: desiredTags
          },
          { role: 'lead', name: 'user' }
        )
      }
    }
  }

  const syncBoardTaskToPlanner = (task: Task): void => {
    const item = planner.get(task.id)
    const isDone = task.state === 'done'
    if (!item) {
      planner.createItem({
        id: task.id,
        title: task.title,
        note: task.brief,
        project: task.tags?.[0],
        createdBy: task.createdBy || 'user',
        done: isDone
      })
    } else {
      const needsDoneUpdate = item.done !== isDone
      const needsTitleUpdate = item.title !== task.title
      const needsNoteUpdate = (item.note || '') !== (task.brief || '')
      const needsProjectUpdate = task.tags?.[0] !== undefined && item.project !== task.tags[0]

      if (needsDoneUpdate || needsTitleUpdate || needsNoteUpdate || needsProjectUpdate) {
        planner.updateItem(task.id, {
          ...(needsDoneUpdate ? { done: isDone } : {}),
          ...(needsTitleUpdate ? { title: task.title } : {}),
          ...(needsNoteUpdate ? { note: task.brief } : {}),
          ...(needsProjectUpdate ? { project: task.tags?.[0] || null } : {})
        })
      }
    }
  }

  // 1. Initial hydration / reconciliation
  isSyncing = true
  try {
    const initialPlanItems = planner.list()
    const initialPlanIds = new Set(initialPlanItems.map((i) => i.id))
    for (const item of initialPlanItems) {
      syncPlanItemToBoard(item)
    }

    const initialTasks = coordination.snapshot().tasks
    for (const task of initialTasks) {
      if (!initialPlanIds.has(task.id)) {
        syncBoardTaskToPlanner(task)
      }
    }
  } finally {
    isSyncing = false
  }

  // 2. Planner -> Board listener
  const onPlannerChange = (items: PlanItem[]): void => {
    if (isSyncing) return
    isSyncing = true
    try {
      const currentIds = new Set(items.map((i) => i.id))
      for (const item of items) {
        syncPlanItemToBoard(item)
      }
      // Remove any tasks on board that were deleted in planner
      const boardTasks = coordination.snapshot().tasks
      for (const task of boardTasks) {
        if (!currentIds.has(task.id)) {
          coordination.deleteTask(task.id)
        }
      }
    } finally {
      isSyncing = false
    }
  }

  // 3. Board -> Planner listener
  const onCoordinationChange = (snapshot: { tasks: Task[] }): void => {
    if (isSyncing) return
    isSyncing = true
    try {
      const currentTaskIds = new Set(snapshot.tasks.map((t) => t.id))
      for (const task of snapshot.tasks) {
        syncBoardTaskToPlanner(task)
      }
      // Remove any items in planner that were deleted on board
      const planItems = planner.list()
      for (const item of planItems) {
        if (!currentTaskIds.has(item.id)) {
          planner.deleteItem(item.id)
        }
      }
    } finally {
      isSyncing = false
    }
  }

  planner.on('change', onPlannerChange)
  coordination.on('change', onCoordinationChange)

  return () => {
    planner.off('change', onPlannerChange)
    coordination.off('change', onCoordinationChange)
  }
}
