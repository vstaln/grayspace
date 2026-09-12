import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUDGET_60HZ_MS,
  estimateRefreshMs,
  frameStats,
  meetsStable60
} from '../renderer/src/lib/frameMetrics.ts'

/** Timestamps for `count` frames each `intervalMs` apart, starting at `start`. */
function steady(count: number, intervalMs: number, start = 0): number[] {
  return Array.from({ length: count }, (_, i) => start + i * intervalMs)
}

describe('frameStats', () => {
  it('reports 60fps for a perfectly paced 60Hz run', () => {
    const stats = frameStats(steady(601, BUDGET_60HZ_MS))
    assert.equal(stats.frames, 601)
    assert.ok(Math.abs(stats.avgFps - 60) < 0.01, `avgFps was ${stats.avgFps}`)
    assert.equal(stats.overBudget, 0)
    assert.equal(stats.droppedFrames, 0)
  })

  it('derives the mean rate from elapsed time, not from the mean interval', () => {
    // 10 frames at 10ms then one 110ms stall: 11 intervals over 200ms.
    const timestamps = [...steady(11, 10), 210]
    const stats = frameStats(timestamps)
    assert.equal(stats.frames, 12)
    assert.ok(Math.abs(stats.durationMs - 210) < 0.001)
    assert.ok(Math.abs(stats.avgFps - (11 / 210) * 1000) < 0.001)
  })

  it('counts a long hitch as every vsync slot it swallowed', () => {
    // One 100ms gap at a 16.67ms budget is 6 slots: 5 of them presented nothing.
    const stats = frameStats([0, 100], BUDGET_60HZ_MS)
    assert.equal(stats.overBudget, 1)
    assert.equal(stats.droppedFrames, 5)
    assert.ok(Math.abs(stats.longestMs - 100) < 0.001)
  })

  it('does not count a frame arriving slightly late as a miss', () => {
    const stats = frameStats([0, BUDGET_60HZ_MS * 1.2], BUDGET_60HZ_MS)
    assert.equal(stats.overBudget, 0)
    assert.equal(stats.droppedFrames, 0)
  })

  it('takes percentiles over the tail, so a stutter cannot hide behind the median', () => {
    // 99 good frames and one 200ms hitch.
    const timestamps = [...steady(100, BUDGET_60HZ_MS), 99 * BUDGET_60HZ_MS + 200]
    const stats = frameStats(timestamps)
    assert.ok(Math.abs(stats.p50Ms - BUDGET_60HZ_MS) < 0.001, `p50 was ${stats.p50Ms}`)
    assert.ok(Math.abs(stats.longestMs - 200) < 0.001)
    assert.ok(stats.p99Ms > BUDGET_60HZ_MS, 'p99 must see the hitch')
  })

  it('ignores duplicate and non-monotonic timestamps instead of reporting 0ms frames', () => {
    // The repeated 16 and the backwards step to 10 carry no interval, so only
    // 0->16 and 10->26 are real — both comfortably inside a 60Hz slot.
    const stats = frameStats([0, 16, 16, 10, 26])
    assert.equal(stats.overBudget, 0, 'a discarded sample must not look like a miss')
    assert.equal(stats.droppedFrames, 0)
    assert.ok(stats.p50Ms > 0, 'a zero interval must not reach the percentiles')
    assert.ok(Math.abs(stats.p50Ms - 16) < 0.001, `p50 was ${stats.p50Ms}`)
  })

  it('returns a zeroed report rather than NaN for too few samples', () => {
    const stats = frameStats([42])
    assert.equal(stats.frames, 1)
    assert.equal(stats.avgFps, 0)
    assert.equal(stats.p99Ms, 0)
    assert.equal(stats.droppedFrames, 0)
  })

  it('honours a non-60Hz budget', () => {
    const budget = 1000 / 144
    const stats = frameStats(steady(145, budget), budget)
    assert.equal(stats.overBudget, 0)
    assert.ok(Math.abs(stats.avgFps - 144) < 0.05, `avgFps was ${stats.avgFps}`)
  })
})

describe('estimateRefreshMs', () => {
  it('recovers the panel interval from a clean run', () => {
    const estimate = estimateRefreshMs(steady(120, 1000 / 120))
    assert.ok(estimate !== null)
    assert.ok(Math.abs((estimate as number) - 1000 / 120) < 0.5, `estimate was ${estimate}`)
  })

  it('is not dragged upwards by stutter in the run', () => {
    // Mostly 120Hz, with a quarter of the frames badly late.
    const timestamps: number[] = [0]
    for (let i = 1; i < 120; i++) {
      timestamps.push(timestamps[i - 1] + (i % 4 === 0 ? 60 : 1000 / 120))
    }
    const estimate = estimateRefreshMs(timestamps)
    assert.ok(estimate !== null)
    assert.ok((estimate as number) < 12, `estimate was ${estimate}, the stalls leaked in`)
  })

  it('declines to guess from too few samples', () => {
    assert.equal(estimateRefreshMs([0, 16, 32]), null)
  })
})

describe('meetsStable60', () => {
  it('passes a clean 60Hz run', () => {
    const verdict = meetsStable60(frameStats(steady(601, BUDGET_60HZ_MS)))
    assert.equal(verdict.pass, true, verdict.reasons.join('; '))
  })

  it('fails a run that averages 60fps but alternates fast and slow frames', () => {
    // 8ms / 25ms alternating averages just over 60fps and looks broken.
    const timestamps: number[] = [0]
    for (let i = 1; i < 400; i++) {
      timestamps.push(timestamps[i - 1] + (i % 2 === 0 ? 8 : 25))
    }
    const stats = frameStats(timestamps)
    assert.ok(stats.avgFps > 60, `guard assumption broken: avgFps ${stats.avgFps}`)
    const verdict = meetsStable60(stats)
    assert.equal(verdict.pass, false, 'a visibly stuttering run must not pass')
  })

  it('fails on a single large hitch even when everything else is clean', () => {
    const timestamps = [...steady(600, BUDGET_60HZ_MS), 599 * BUDGET_60HZ_MS + 400]
    const verdict = meetsStable60(frameStats(timestamps))
    assert.equal(verdict.pass, false)
    assert.ok(verdict.reasons.some((r) => r.includes('hitch')), verdict.reasons.join('; '))
  })

  it('fails a steady 50fps run', () => {
    const verdict = meetsStable60(frameStats(steady(500, 20)))
    assert.equal(verdict.pass, false)
    assert.ok(verdict.reasons.some((r) => r.includes('below 60')), verdict.reasons.join('; '))
  })

  it('refuses to judge an empty run instead of passing it', () => {
    const verdict = meetsStable60(frameStats([]))
    assert.equal(verdict.pass, false)
  })
})
