import { useCallback, useEffect, useState } from 'react'
import type { CoordinationSnapshot, TaskState } from '../../../preload/index.d'

const EMPTY: CoordinationSnapshot = { managerId: null, tasks: [], locks: [] }

/** Live mirror of the main process coordination store (manager, tasks, locks). */
export function useCoordination() {
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot>(EMPTY)

  useEffect(() => {
    void window.api.coordination.status().then(setSnapshot)
    return window.api.coordination.onChange(setSnapshot)
  }, [])

  const createTask = useCallback(async (title: string, brief?: string): Promise<void> => {
    await window.api.coordination.createTask({ title, brief })
  }, [])

  const moveTask = useCallback(async (id: string, state: TaskState): Promise<void> => {
    await window.api.coordination.updateTask(id, { state })
  }, [])

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    await window.api.coordination.deleteTask(id)
  }, [])

  const resetManager = useCallback(async (): Promise<void> => {
    setSnapshot(await window.api.coordination.resetManager())
  }, [])

  const releaseLocks = useCallback(async (): Promise<void> => {
    setSnapshot(await window.api.coordination.releaseLocks())
  }, [])

  return { snapshot, createTask, moveTask, deleteTask, resetManager, releaseLocks }
}
