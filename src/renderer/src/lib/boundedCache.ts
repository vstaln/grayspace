/**
 * Drop entries from the front until the collection is within `max`.
 *
 * Both Map and Set iterate in insertion order, so the front is the oldest
 * entry — the one least likely to still be wanted. Every per-widget cache in
 * the renderer is keyed by an id that is normally cleaned up explicitly when
 * the widget goes away; this is the backstop for the paths that never reach
 * that cleanup, so the cache cannot grow for the life of the session.
 */
export function capOldest(
  collection: { size: number; keys(): IterableIterator<string>; delete(key: string): boolean },
  max: number
): void {
  while (collection.size > max) {
    const oldest = collection.keys().next().value as string | undefined
    if (oldest === undefined) break
    collection.delete(oldest)
  }
}
