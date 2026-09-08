import { ActorRegistry } from './actors.ts'
import { CommandFlow } from './flow.ts'
import { ContentAddressedStore } from './cas.ts'
import { Journal, type JournalSink } from './journal.ts'
import { ProjectionManager } from './projections.ts'
import type { JournalEntry } from './types.ts'
import { LockManager } from './locks.ts'

export { ActorRegistry, ACTOR_TTL_MS } from './actors.ts'
export { CommandFlow, type CommandFlowOptions } from './flow.ts'
export { ContentAddressedStore, type CasStats } from './cas.ts'
export { IdempotencyCache, type IdempotencyRecord } from './idempotency.ts'
export { Journal, GENESIS_HASH, computeEntryHash } from './journal.ts'
export type { JournalSink, JournalOptions } from './journal.ts'
export {
  LockManager,
  DEFAULT_LOCK_TTL_MS,
  MIN_LOCK_TTL_MS,
  MAX_LOCK_TTL_MS,
  type ResourceLock
} from './locks.ts'
export { MigrationRunner, type Migration, type MigrationResult } from './migrations.ts'
export {
  ProjectionManager,
  type ResourceSummary,
  type ActorSummary,
  type ActivityDigest
} from './projections.ts'
export { ActorRateLimiter, PriorityCommandQueue, type QueuedTask } from './queue.ts'
export { MetricsRegistry, type MetricsSnapshot, type TimingStats } from './metrics.ts'
export { fileResource, isResourceId, parseResource, resourceId } from './resources.ts'
export {
  validatePayload,
  type CommandDefinition,
  type CommandPayloadSchema,
  type FieldSchema
} from './schema.ts'
export { VersionRegistry, stamp, type Versioned } from './versioned.ts'
export { ShadowOverlay, OverlayManager, type OverlayRecord } from './overlay.ts'
export {
  fold,
  replay,
  rewind,
  blame,
  fork,
  type EventReducer,
  type StoreSnapshot
} from './events.ts'
export * from './types.ts'

export interface Core {
  actors: ActorRegistry
  locks: LockManager
  journal: Journal
  flow: CommandFlow
  projections: ProjectionManager
  cas: ContentAddressedStore

  sweepDeadActors(): void
  dispose(): void
}





export function createCore(
  options: {
    sink?: JournalSink
    startSeq?: number
    now?: () => number
    seed?: readonly JournalEntry[]
    casRootDir?: string
  } = {}
): Core {
  const now = options.now ?? Date.now
  const actors = new ActorRegistry(now)
  const locks = new LockManager({ now })
  const journal = new Journal({ sink: options.sink, startSeq: options.startSeq, now, seed: options.seed })
  const flow = new CommandFlow({ actors, locks, journal, now })
  const projections = new ProjectionManager(journal, { now })
  const cas = new ContentAddressedStore({ rootDir: options.casRootDir })




  actors.register({ id: 'system', type: 'system', label: 'OrcSpace', transport: 'internal' })

  const sweepDeadActors = (): void => {
    for (const dead of actors.pruneDead()) locks.releaseAllFor(dead.id)
    locks.sweep()
  }

  const heartbeat = setInterval(sweepDeadActors, 10_000)
  heartbeat.unref?.()
  locks.startSweeper()

  return {
    actors,
    locks,
    journal,
    flow,
    projections,
    cas,
    sweepDeadActors,
    dispose(): void {
      clearInterval(heartbeat)
      locks.stopSweeper()
      journal.flush()
    }
  }
}
