import type { Journal } from './journal.ts'
import type { JournalEntry, ResourceId, ResourceScheme } from './types.ts'
import { parseResource } from './resources.ts'

export interface ResourceSummary {
  target: ResourceId
  scheme: ResourceScheme
  version: number
  firstSeenAt: number
  lastUpdatedAt: number
  commitCount: number
  lastActorId: string
  lastType: string
  commits: JournalEntry[]
}

export interface ActorSummary {
  actorId: string
  lastSeenAt: number
  commitCount: number
  lastType: string
  lastTarget: ResourceId
  touchedResources: Set<ResourceId>
}

export interface ActivityDigest {
  windowMs: number
  from: number
  to: number
  totalCommits: number
  byScheme: Record<string, number>
  byActor: Record<string, number>
  recentCommits: JournalEntry[]
}

/**
 * Real-time materialized projections updated synchronously on each journal event.
 * Eliminates NDJSON scans for timelines, activity feeds and actor status.
 */
export class ProjectionManager {
  private readonly resourceMap = new Map<ResourceId, ResourceSummary>()
  private readonly actorMap = new Map<string, ActorSummary>()
  private readonly rollingCommits: JournalEntry[] = []
  private readonly maxRollingEntries: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(
    journal: Journal,
    options: { maxRollingEntries?: number; windowMs?: number; now?: () => number } = {}
  ) {
    this.maxRollingEntries = options.maxRollingEntries ?? 1_000
    this.windowMs = options.windowMs ?? 60 * 60_000 // 1 hour window
    this.now = options.now ?? Date.now

    // Seed from existing journal entries
    for (const entry of journal.all()) {
      this.handleEntry(entry)
    }

    // Subscribe to new journal entries
    journal.on('entry', (entry: JournalEntry) => this.handleEntry(entry))
  }

  private handleEntry(entry: JournalEntry): void {
    if (entry.phase !== 'commit') return

    // 1. Update Resource History Projection
    const parsed = parseResource(entry.target)
    const scheme = parsed ? parsed.scheme : ('system' as ResourceScheme)
    let res = this.resourceMap.get(entry.target)
    if (!res) {
      res = {
        target: entry.target,
        scheme,
        version: entry.version ?? 1,
        firstSeenAt: entry.at,
        lastUpdatedAt: entry.at,
        commitCount: 1,
        lastActorId: entry.actorId,
        lastType: entry.type,
        commits: [entry]
      }
      this.resourceMap.set(entry.target, res)
    } else {
      res.version = entry.version ?? res.version + 1
      res.lastUpdatedAt = entry.at
      res.commitCount += 1
      res.lastActorId = entry.actorId
      res.lastType = entry.type
      res.commits.push(entry)
      if (res.commits.length > 200) res.commits.splice(0, res.commits.length - 200)
    }

    // 2. Update Actor Activity Projection
    let act = this.actorMap.get(entry.actorId)
    if (!act) {
      act = {
        actorId: entry.actorId,
        lastSeenAt: entry.at,
        commitCount: 1,
        lastType: entry.type,
        lastTarget: entry.target,
        touchedResources: new Set([entry.target])
      }
      this.actorMap.set(entry.actorId, act)
    } else {
      act.lastSeenAt = entry.at
      act.commitCount += 1
      act.lastType = entry.type
      act.lastTarget = entry.target
      act.touchedResources.add(entry.target)
    }

    // 3. Update Rolling Recent Activity
    this.rollingCommits.push(entry)
    if (this.rollingCommits.length > this.maxRollingEntries) {
      this.rollingCommits.splice(0, this.rollingCommits.length - this.maxRollingEntries)
    }
  }

  /**
   * Returns complete history and summary for a single resource in O(1).
   */
  resourceHistory(target: ResourceId): ResourceSummary | undefined {
    return this.resourceMap.get(target)
  }

  /**
   * Returns real-time activity status for an actor in O(1).
   */
  actorStatus(actorId: string): (Omit<ActorSummary, 'touchedResources'> & { touchedResources: string[] }) | undefined {
    const act = this.actorMap.get(actorId)
    if (!act) return undefined
    return {
      ...act,
      touchedResources: Array.from(act.touchedResources)
    }
  }

  /**
   * Returns aggregated activity digest over the rolling time window (e.g. past hour).
   */
  recentDigest(customWindowMs?: number): ActivityDigest {
    const window = customWindowMs ?? this.windowMs
    const now = this.now()
    const cutoff = now - window
    const inWindow = this.rollingCommits.filter((e) => e.at >= cutoff)

    const byScheme: Record<string, number> = {}
    const byActor: Record<string, number> = {}

    for (const e of inWindow) {
      const parsed = parseResource(e.target)
      const s = parsed?.scheme ?? 'system'
      byScheme[s] = (byScheme[s] || 0) + 1
      byActor[e.actorId] = (byActor[e.actorId] || 0) + 1
    }

    return {
      windowMs: window,
      from: cutoff,
      to: now,
      totalCommits: inWindow.length,
      byScheme,
      byActor,
      recentCommits: inWindow.slice(-100)
    }
  }
}
