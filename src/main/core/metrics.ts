/**
 * Dependency-free counters/gauges/timings for the write path.
 *
 * Deliberately not a general metrics library: the bus needs a handful of
 * numbers (queue depth, conflicts, apply latency) observable from the sys
 * monitor, with zero allocation on the hot path beyond a Map increment.
 */
export interface TimingStats {
  /** Samples kept (sliding window). */
  count: number
  avgMs: number
  maxMs: number
  lastMs: number
}

export interface MetricsSnapshot {
  counters: Record<string, number>
  gauges: Record<string, number>
  timings: Record<string, TimingStats>
}

const WINDOW_SIZE = 256

interface TimingAccumulator {
  window: number[]
  index: number
  total: number
  max: number
  last: number
  seen: number
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>()
  private readonly gauges = new Map<string, number>()
  private readonly timings = new Map<string, TimingAccumulator>()

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value)
  }

  observe(name: string, ms: number): void {
    let acc = this.timings.get(name)
    if (!acc) {
      acc = { window: [], index: 0, total: 0, max: 0, last: 0, seen: 0 }
      this.timings.set(name, acc)
    }
    if (acc.window.length < WINDOW_SIZE) {
      acc.window.push(ms)
      acc.total += ms
    } else {
      acc.total -= acc.window[acc.index]
      acc.window[acc.index] = ms
      acc.total += ms
    }
    acc.index = (acc.index + 1) % WINDOW_SIZE
    acc.last = ms
    acc.seen += 1
    if (ms > acc.max) acc.max = ms
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {}
    for (const [k, v] of this.counters) counters[k] = v
    const gauges: Record<string, number> = {}
    for (const [k, v] of this.gauges) gauges[k] = v
    const timings: Record<string, TimingStats> = {}
    for (const [k, acc] of this.timings) {
      timings[k] =
        acc.seen === 0
          ? { count: 0, avgMs: 0, maxMs: 0, lastMs: 0 }
          : { count: acc.seen, avgMs: Math.round((acc.total / acc.window.length) * 100) / 100, maxMs: Math.round(acc.max * 100) / 100, lastMs: Math.round(acc.last * 100) / 100 }
    }
    return { counters, gauges, timings }
  }
}
