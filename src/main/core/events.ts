import type { JournalEntry, ResourceId } from './types.ts'

/**
 * Reducer function for an event-sourced store.
 * Pure and deterministic: (state, event) => newState.
 */
export type EventReducer<S, P = unknown> = (state: S, event: JournalEntry) => S

export interface StoreSnapshot<S> {
  snapshotSeq: number
  state: S
  schemaVersion?: number
  updatedAt?: number
}

/**
 * Folds a sequence of journal entries (events) into an accumulated state.
 * Only 'commit' phase entries represent committed domain events.
 */
export function fold<S>(
  events: Iterable<JournalEntry>,
  reducer: EventReducer<S>,
  initialState: S
): S {
  let state = initialState
  for (const entry of events) {
    if (entry.phase === 'commit') {
      state = reducer(state, entry)
    }
  }
  return state
}

/**
 * Replays committed events to compute or verify the resulting state.
 */
export function replay<S>(
  events: Iterable<JournalEntry>,
  reducer: EventReducer<S>,
  initialState: S
): S {
  return fold(events, reducer, initialState)
}

/**
 * Rewinds state to a historical sequence number 	argetSeq.
 * Starts from ase (snapshot or initial state) and folds committed events up to 	argetSeq.
 */
export function rewind<S>(
  targetSeq: number,
  events: Iterable<JournalEntry>,
  reducer: EventReducer<S>,
  base: { snapshotSeq?: number; seq?: number; state: S } | S
): S {
  const isSnapshotObj =
    base !== null &&
    typeof base === 'object' &&
    'state' in (base as Record<string, unknown>) &&
    (('snapshotSeq' in (base as Record<string, unknown>)) || ('seq' in (base as Record<string, unknown>)))

  const baseSeq = isSnapshotObj
    ? Number((base as { snapshotSeq?: number; seq?: number }).snapshotSeq ?? (base as { seq?: number }).seq ?? 0)
    : 0
  const initialState = isSnapshotObj ? (base as { state: S }).state : (base as S)

  let state = initialState
  for (const entry of events) {
    if (entry.seq > targetSeq) break
    if (entry.seq > baseSeq && entry.phase === 'commit') {
      state = reducer(state, entry)
    }
  }
  return state
}

/**
 * Blame: extracts the audit trail for a specific resource target.
 * Returns all committed events touching 	arget, oldest first.
 */
export function blame(
  target: ResourceId,
  events: Iterable<JournalEntry>
): JournalEntry[] {
  const history: JournalEntry[] = []
  for (const entry of events) {
    if (entry.phase === 'commit') {
      if (entry.target === target) {
        history.push(entry)
      } else if (
        entry.type === 'bus.transact' &&
        Array.isArray((entry.payload as { commands?: Array<{ target?: string }> })?.commands)
      ) {
        const hasTarget = (entry.payload as { commands: Array<{ target?: string }> }).commands.some(
          (c) => c.target === target
        )
        if (hasTarget) history.push(entry)
      }
    }
  }
  return history
}

/**
 * Deep clones state for branching/forking.
 */
export function fork<S>(
  _forkId: string,
  state: S,
  cloneFn?: (state: S) => S
): S {
  if (cloneFn) return cloneFn(state)
  if (state === null || typeof state !== 'object') return state
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(state) as S
    } catch {
      /* not structurally cloneable — fall through to per-kind copies */
    }
  }
  if (Array.isArray(state)) {
    return state.map((item) => (typeof item === 'object' && item !== null ? { ...item } : item)) as unknown as S
  }
  if (state instanceof Map) {
    const next = new Map()
    for (const [k, v] of state.entries()) {
      next.set(k, typeof v === 'object' && v !== null ? { ...v } : v)
    }
    return next as unknown as S
  }
  if (state instanceof Set) {
    return new Set(state) as unknown as S
  }
  return JSON.parse(JSON.stringify(state)) as S
}
