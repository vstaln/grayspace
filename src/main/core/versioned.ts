import { resourceId } from './resources.ts'
import type { ResourceId, ResourceScheme, VersionSource } from './types.ts'

/** Anything the bus can version-check carries these two fields. */
export interface Versioned {
  id: string
  version: number
  updatedAt: number
}

/**
 * The bookkeeping every store needs to participate in optimistic concurrency,
 * in one place instead of copy-pasted four times.
 *
 * A store keeps its own domain objects; this only tracks "what version is
 * `note:abc` at right now", which is the single question the bus asks. Objects
 * are bumped through {@link bump} on every accepted write, so a `baseVersion`
 * from a stale reader can never match.
 */
export class VersionRegistry implements VersionSource {
  private readonly versions = new Map<ResourceId, number>()
  private readonly scheme: ResourceScheme

  constructor(scheme: ResourceScheme) {
    this.scheme = scheme
  }

  target(id: string): ResourceId {
    return resourceId(this.scheme, id)
  }

  versionOf(target: ResourceId): number | undefined {
    return this.versions.get(target)
  }

  /** Version of an object by its bare id (no scheme), `0` when unknown. */
  current(id: string): number {
    return this.versions.get(this.target(id)) ?? 0
  }

  /** Advances the version of an object and returns the new value. */
  bump(id: string): number {
    const next = this.current(id) + 1
    this.versions.set(this.target(id), next)
    return next
  }

  /** Seeds versions from persisted objects on load, without bumping them. */
  seed(objects: Iterable<{ id: string; version?: number }>): void {
    for (const object of objects) {
      this.versions.set(this.target(object.id), Math.max(1, Number(object.version) || 1))
    }
  }

  forget(id: string): void {
    this.versions.delete(this.target(id))
  }

  size(): number {
    return this.versions.size
  }
}

/** Stamps a fresh object with the version bookkeeping the bus expects. */
export function stamp<T extends { id: string }>(
  registry: VersionRegistry,
  object: T,
  now = Date.now()
): T & Versioned {
  return { ...object, version: registry.bump(object.id), updatedAt: now }
}
