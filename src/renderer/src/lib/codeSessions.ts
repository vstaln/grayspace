/**
 * How many Code sessions are open, shared across components.
 *
 * The sidebar hides its workspace panel until Code has something running:
 * before the first session there is nothing to save a workspace *of*, and the
 * panel repeats the folder line the launcher already shows.
 *
 * A store rather than a window event, because the two components do not mount
 * in a fixed order. An event only reaches listeners that already exist, so a
 * sidebar mounting after CodeView had announced its count would never learn
 * it and would stay hidden with sessions running — which is exactly what
 * happened when this was an event.
 *
 * Not React state: the value is owned by CodeView and read by a sibling, so
 * lifting it into App would give App a third meaning of "code is active"
 * alongside the two it already tracks.
 */

let count = 0
const listeners = new Set<(count: number) => void>()

export function setCodeSessionCount(next: number): void {
  const clamped = Math.max(0, Math.floor(next))
  if (clamped === count) return
  count = clamped
  for (const listener of listeners) {
    try {
      listener(count)
    } catch {
      // One bad subscriber must not stop the others from updating.
    }
  }
}

export function getCodeSessionCount(): number {
  return count
}

/** Subscribes and immediately delivers the current value. */
export function onCodeSessionCount(listener: (count: number) => void): () => void {
  listeners.add(listener)
  try {
    listener(count)
  } catch {
    // A subscriber that throws on subscribe must not break the subscriber:
    // without this the exception would propagate out of the call and the
    // caller would never receive its unsubscribe function.
  }
  return () => {
    listeners.delete(listener)
  }
}
