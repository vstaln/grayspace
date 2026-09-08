import type { JournalEntry, OverlayDiffEntry, ResourceId } from './types.ts'

export interface OverlayRecord<T = unknown> {
  value: T
  deleted?: boolean
  version: number
}





export class ShadowOverlay {
  readonly id: string
  readonly createdAt: number
  private readonly records = new Map<ResourceId, OverlayRecord>()
  private readonly logs: JournalEntry[] = []

  constructor(id: string, now = Date.now()) {
    this.id = id
    this.createdAt = now
  }

  get<T = unknown>(target: ResourceId): OverlayRecord<T> | undefined {
    return this.records.get(target) as OverlayRecord<T> | undefined
  }

  set<T = unknown>(target: ResourceId, value: T, version: number): void {
    this.records.set(target, { value, version, deleted: false })
  }

  delete(target: ResourceId, version = 0): void {
    this.records.set(target, { value: undefined, version, deleted: true })
  }

  has(target: ResourceId): boolean {
    return this.records.has(target)
  }

  isDeleted(target: ResourceId): boolean {
    return this.records.get(target)?.deleted === true
  }

  recordLog(entry: JournalEntry): void {
    this.logs.push(entry)
  }

  getLogs(): JournalEntry[] {
    return this.logs.slice()
  }

  diff(): OverlayDiffEntry[] {
    const changes: OverlayDiffEntry[] = []
    for (const [target, record] of this.records.entries()) {
      changes.push({
        target,
        op: record.deleted ? 'delete' : 'put',
        value: record.value,
        version: record.version
      })
    }
    return changes
  }

  entries(): Array<[ResourceId, OverlayRecord]> {
    return Array.from(this.records.entries())
  }

  size(): number {
    return this.records.size
  }

  clear(): void {
    this.records.clear()
    this.logs.length = 0
  }
}




export class OverlayManager {
  private readonly overlays = new Map<string, ShadowOverlay>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  create(id: string): ShadowOverlay {
    let overlay = this.overlays.get(id)
    if (!overlay) {
      overlay = new ShadowOverlay(id, this.now())
      this.overlays.set(id, overlay)
    }
    return overlay
  }

  get(id: string): ShadowOverlay | undefined {
    return this.overlays.get(id)
  }

  has(id: string): boolean {
    return this.overlays.has(id)
  }

  discard(id: string): boolean {
    return this.overlays.delete(id)
  }

  list(): string[] {
    return Array.from(this.overlays.keys()).sort()
  }




  readComposite<T>(target: ResourceId, baseValue: T | undefined, overlayId?: string): T | undefined {
    if (!overlayId) return baseValue
    const overlay = this.overlays.get(overlayId)
    if (!overlay) return baseValue
    const record = overlay.get<T>(target)
    if (!record) return baseValue
    if (record.deleted) return undefined
    return record.value
  }




  readCompositeList<T extends { id: string }>(
    baseItems: T[],
    getTarget: (item: T) => ResourceId,
    overlayId?: string
  ): T[] {
    if (!overlayId) return baseItems.slice()
    const overlay = this.overlays.get(overlayId)
    if (!overlay) return baseItems.slice()

    const itemMap = new Map<string, T>()
    for (const item of baseItems) {
      const itemTarget = getTarget(item)
      if (overlay.isDeleted(itemTarget)) continue
      const overlaid = overlay.get<T>(itemTarget)
      itemMap.set(item.id, overlaid && !overlaid.deleted ? overlaid.value : item)
    }

    for (const [, record] of overlay.entries()) {
      if (record.deleted || record.value == null) continue
      const val = record.value as T
      if (val && typeof val.id === 'string') {
        itemMap.set(val.id, val)
      }
    }

    return Array.from(itemMap.values())
  }
}
