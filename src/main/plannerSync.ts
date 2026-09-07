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
  // Ids the sync has actually seen on each side. Deletion propagation only
  // removes ids known to have existed there: a board task created concurrently
  // with a planner event (or by a path that bypasses the planner) must not be
  // treated as "deleted in planner" just because it is absent from that event.
  const knownPlanIds = new Set<string>()
  const knownTaskIds = new Set<string>()

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
    for (const item of planner.list()) knownPlanIds.add(item.id)
    for (const task of coordination.snapshot().tasks) knownTaskIds.add(task.id)
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
      // Remove board tasks deleted in planner — but only ids this sync has
      // seen on the board before. Anything else (created concurrently with
      // this event, or a momentarily-empty source snapshot after a restart) is
      // not evidence of a deletion.
      const boardTasks = coordination.snapshot().tasks
      for (const task of boardTasks) {
        if (!currentIds.has(task.id) && knownTaskIds.has(task.id)) {
          coordination.deleteTask(task.id)
          knownTaskIds.delete(task.id)
        } else {
          // Tasks just created above (or concurrently) join the known set so
          // a later planner deletion still propagates to them.
          knownTaskIds.add(task.id)
        }
      }
      for (const id of currentIds) knownPlanIds.add(id)
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
      // Same known-id rule on this side: only planner items previously seen
      // may be treated as deleted on the board.
      const planItems = planner.list()
      for (const item of planItems) {
        if (!currentTaskIds.has(item.id) && knownPlanIds.has(item.id)) {
          planner.deleteItem(item.id)
          knownPlanIds.delete(item.id)
        } else {
          knownPlanIds.add(item.id)
        }
      }
      for (const id of currentTaskIds) knownTaskIds.add(id)
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
