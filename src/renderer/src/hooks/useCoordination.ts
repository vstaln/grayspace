import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoordinationSnapshot, TaskState } from '../../../preload/index.d'

const EMPTY: CoordinationSnapshot = { managerId: null, tasks: [], locks: [] }

/** Live mirror of the main process coordination store (manager, tasks, locks). */
export function useCoordination() {
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot>(EMPTY)
  // Guards the status() fetch against racing a newer onChange broadcast: if a
  // change arrives while status() is still in flight, the stale status result
  // must not overwrite the fresher snapshot with an older task list.
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    void window.api.coordination.status()
      .then((s) => {
        if (seq >= seqRef.current) setSnapshot(s)
      })
      .catch(() => {
        // IPC hiccup: keep the empty mirror; the board widget shows its own
        // error banner and the next onChange/retry repopulates it.
      })
    const off = window.api.coordination.onChange((s) => {
      seqRef.current += 1
      setSnapshot(s)
    })
    return () => {
      seqRef.current += 1
      off()
    }
  }, [])

  const createTask = useCallback(async (title: string, brief?: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const result = await window.api.coordination.createTask({ title, brief })
      if (result && typeof result === 'object' && 'error' in result) return { ok: false, error: String(result.error) }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const moveTask = useCallback(
    async (id: string, state: TaskState): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Pass the version the board last saw, so a drag can't silently
        // overwrite a concurrent agent state change (last-write-wins clobber
        // the baseVersion contract exists to prevent — AUD-04).
        const task = snapshot.tasks.find((t) => t.id === id)
        const result = await window.api.coordination.updateTask(id, { state, baseVersion: task?.version })
        if (result && typeof result === 'object' && 'error' in result) return { ok: false, error: String(result.error) }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    [snapshot]
  )

  const deleteTask = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const result = await window.api.coordination.deleteTask(id)
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        return { ok: false, error: String(result.error) }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const resetManager = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const seq = ++seqRef.current
    try {
      const next = await window.api.coordination.resetManager()
      // An onChange can arrive while the recovery call is in flight. Do not
      // replace that newer snapshot with the response captured before it.
      if (seq === seqRef.current) setSnapshot(next)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const releaseLocks = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const seq = ++seqRef.current
    try {
      const next = await window.api.coordination.releaseLocks()
      if (seq === seqRef.current) setSnapshot(next)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  return { snapshot, createTask, moveTask, deleteTask, resetManager, releaseLocks }
}
