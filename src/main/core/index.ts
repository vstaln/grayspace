import { ActorRegistry } from './actors.ts'
import { CommandBus } from './bus.ts'
import { Journal, type JournalSink } from './journal.ts'
import { LockManager } from './locks.ts'

export { ActorRegistry, ACTOR_TTL_MS } from './actors.ts'
export { CommandBus } from './bus.ts'
export { Journal } from './journal.ts'
export type { JournalSink, JournalOptions } from './journal.ts'
export {
  LockManager,
  DEFAULT_LOCK_TTL_MS,
  MIN_LOCK_TTL_MS,
  MAX_LOCK_TTL_MS,
  type ResourceLock
} from './locks.ts'
export { fileResource, isResourceId, parseResource, resourceId } from './resources.ts'
export { VersionRegistry, stamp, type Versioned } from './versioned.ts'
export * from './types.ts'

export interface Core {
  actors: ActorRegistry
  locks: LockManager
  journal: Journal
  bus: CommandBus
  /** Releases the locks of every actor that has gone quiet. */
  sweepDeadActors(): void
  dispose(): void
}

/**
 * Wires the three core components together. Everything else in the app —
 * stores, transports, the assistant — takes this object and nothing else.
 *
 * Note what is *not* here: any call to restore locks. Locks are in-memory by
 * construction, so a fresh process starts with every resource free, which is
 * the correct state after a restart killed every process that held one.
 */
export function createCore(options: { sink?: JournalSink; startSeq?: number; now?: () => number } = {}): Core {
  const now = options.now ?? Date.now
  const actors = new ActorRegistry(now)
  const locks = new LockManager({ now })
  const journal = new Journal({ sink: options.sink, startSeq: options.startSeq, now })
  const bus = new CommandBus({ actors, locks, journal, now })

  // The system actor exists so internal maintenance (migrations, recovery,
  // shutdown flushes) is attributable in the journal like everything else,
  // rather than appearing as an anonymous write.
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
    bus,
    sweepDeadActors,
    dispose(): void {
      clearInterval(heartbeat)
      locks.stopSweeper()
      journal.flush()
    }
  }
}
