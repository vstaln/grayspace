// Statistics over presented frames.
//
// The input is a list of requestAnimationFrame timestamps. rAF fires once per
// compositor frame and its timestamp is the frame's presentation time, so the
// gaps between consecutive entries are what the viewer actually saw. A timer
// (setInterval/setTimeout) counts its own invocations instead and keeps
// counting while the compositor skips frames, which is why a timer-derived
// "FPS" can read 60 on a window that is visibly stuttering. Nothing here
// derives a frame count from a timer.
//
// Everything is a pure function over the samples so the numbers can be tested
// without launching the app.

export interface FrameStats {
  /** Frames observed. Intervals are one fewer. */
  frames: number
  /** Wall time from the first sample to the last. */
  durationMs: number
  /** Mean rate over the whole window: intervals / elapsed, not 1000/mean. */
  avgFps: number
  /** Interval percentiles in ms, nearest-rank over the sorted intervals. */
  p50Ms: number
  p95Ms: number
  p99Ms: number
  /** The single worst gap — the stutter a user complains about. */
  longestMs: number
  /** Intervals longer than the budget, i.e. frames that missed their slot. */
  overBudget: number
  overBudgetPct: number
  /**
   * Vsync slots that passed with nothing new presented. An interval of one
   * budget is a delivered frame and drops nothing; two budgets means one slot
   * was missed. Summed over the run, so a single long hitch is counted for
   * every slot it swallowed rather than as one event.
   */
  droppedFrames: number
  budgetMs: number
}

/** 60Hz. A display running faster has a smaller budget — see estimateRefreshMs. */
export const BUDGET_60HZ_MS = 1000 / 60

/** How far past its slot a frame may land before it counts as missed. */
const MISS_TOLERANCE = 1.25

/**
 * Infers the display's frame budget from the samples themselves, so a 120Hz or
 * 144Hz panel is not judged against a 60Hz slot it never uses.
 *
 * It takes the fastest realistic interval rather than the mean: the mean is
 * dragged upwards by every stutter in the run, which would quietly relax the
 * budget exactly when the run went badly. The 5th percentile is used instead of
 * the outright minimum because one spuriously short gap (a coalesced callback)
 * would otherwise set the budget for everything.
 *
 * Returns null when there is not enough signal to infer anything; callers
 * should then pass a budget explicitly rather than guess.
 */
export function estimateRefreshMs(timestamps: readonly number[]): number | null {
  const intervals = intervalsOf(timestamps)
  if (intervals.length < 10) return null
  const sorted = [...intervals].sort((a, b) => a - b)
  const fast = percentile(sorted, 5)
  if (!Number.isFinite(fast) || fast <= 0) return null
  return fast
}

export function frameStats(
  timestamps: readonly number[],
  budgetMs: number = BUDGET_60HZ_MS
): FrameStats {
  const intervals = intervalsOf(timestamps)
  const budget = budgetMs > 0 ? budgetMs : BUDGET_60HZ_MS

  if (intervals.length === 0) {
    return {
      frames: timestamps.length,
      durationMs: 0,
      avgFps: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      longestMs: 0,
      overBudget: 0,
      overBudgetPct: 0,
      droppedFrames: 0,
      budgetMs: budget
    }
  }

  const durationMs = timestamps[timestamps.length - 1] - timestamps[0]
  const sorted = [...intervals].sort((a, b) => a - b)

  let overBudget = 0
  let droppedFrames = 0
  let longestMs = 0
  for (const interval of intervals) {
    if (interval > longestMs) longestMs = interval
    // A hair over the budget is the same frame arriving late by rounding, not a
    // miss. The tolerance is deliberately well under 1.5 budgets: at 60Hz that
    // threshold sits exactly on 25ms, so a run pinned at 25ms per frame — a
    // steady 40fps — scored zero misses. A quarter of a budget is past rounding
    // noise and still short of the next vsync.
    if (interval > budget * MISS_TOLERANCE) overBudget += 1
    const slots = Math.round(interval / budget)
    if (slots > 1) droppedFrames += slots - 1
  }

  return {
    frames: timestamps.length,
    durationMs,
    avgFps: durationMs > 0 ? (intervals.length / durationMs) * 1000 : 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    longestMs,
    overBudget,
    overBudgetPct: (overBudget / intervals.length) * 100,
    droppedFrames,
    budgetMs: budget
  }
}

/**
 * "Stable 60 and above" as a pass/fail answer.
 *
 * A mean of 60fps says nothing about smoothness — a run that alternates 8ms and
 * 25ms frames averages just over 60 and looks visibly broken. So the check is
 * on the tail: nearly every frame must land inside its slot, and no single
 * hitch may exceed `maxHitchMs`. The default tolerance allows 1% of frames to
 * miss, which covers the odd GC pause without waving through a run that
 * stutters continuously.
 */
export function meetsStable60(
  stats: FrameStats,
  options: { maxOverBudgetPct?: number; maxHitchMs?: number; maxDroppedPct?: number } = {}
): { pass: boolean; reasons: string[] } {
  const maxOverBudgetPct = options.maxOverBudgetPct ?? 1
  const maxHitchMs = options.maxHitchMs ?? 50
  const maxDroppedPct = options.maxDroppedPct ?? 1
  const reasons: string[] = []

  if (stats.frames < 2) {
    return { pass: false, reasons: ['not enough frames to judge'] }
  }
  if (stats.avgFps < 60) {
    reasons.push(`mean ${stats.avgFps.toFixed(1)}fps is below 60`)
  }
  if (stats.p99Ms > stats.budgetMs * MISS_TOLERANCE) {
    reasons.push(`p99 frame ${stats.p99Ms.toFixed(1)}ms exceeds the ${stats.budgetMs.toFixed(1)}ms budget`)
  }
  if (stats.overBudgetPct > maxOverBudgetPct) {
    reasons.push(`${stats.overBudgetPct.toFixed(1)}% of frames missed their slot (limit ${maxOverBudgetPct}%)`)
  }
  // Counted separately from overBudgetPct: that counts *events*, this counts how
  // much of the run showed nothing new. A handful of very long stalls is a small
  // percentage of frames but a large share of empty vsync slots.
  const expectedSlots = stats.durationMs / stats.budgetMs
  const droppedPct = expectedSlots > 0 ? (stats.droppedFrames / expectedSlots) * 100 : 0
  if (droppedPct > maxDroppedPct) {
    reasons.push(`${droppedPct.toFixed(1)}% of vsync slots presented nothing (limit ${maxDroppedPct}%)`)
  }
  if (stats.longestMs > maxHitchMs) {
    reasons.push(`worst frame ${stats.longestMs.toFixed(1)}ms exceeds the ${maxHitchMs}ms hitch limit`)
  }

  return { pass: reasons.length === 0, reasons }
}

export function formatStats(label: string, stats: FrameStats): string {
  return [
    `${label}:`,
    `  frames ${stats.frames} over ${(stats.durationMs / 1000).toFixed(1)}s`,
    `  mean ${stats.avgFps.toFixed(1)} fps (budget ${stats.budgetMs.toFixed(2)} ms)`,
    `  frame ms  p50 ${stats.p50Ms.toFixed(1)}  p95 ${stats.p95Ms.toFixed(1)}  p99 ${stats.p99Ms.toFixed(1)}  worst ${stats.longestMs.toFixed(1)}`,
    `  missed ${stats.overBudget} (${stats.overBudgetPct.toFixed(1)}%)  dropped slots ${stats.droppedFrames}`
  ].join('\n')
}

function intervalsOf(timestamps: readonly number[]): number[] {
  const intervals: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    const delta = timestamps[i] - timestamps[i - 1]
    // Non-monotonic or duplicate timestamps carry no interval; keeping them
    // would report impossible 0ms frames and inflate the mean rate.
    if (Number.isFinite(delta) && delta > 0) intervals.push(delta)
  }
  return intervals
}

/** Nearest-rank percentile over an already-sorted ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index]
}
