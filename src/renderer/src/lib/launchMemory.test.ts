import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { launchMemoryWarning } from './launchMemory.ts'

const GB = 1024 * 1024 * 1024

describe('launch memory warning', () => {
  it('stays quiet when there is room for every session', () => {
    assert.equal(launchMemoryWarning({ freeBytes: 10 * GB, totalBytes: 16 * GB }, 6), null)
    assert.equal(launchMemoryWarning({ freeBytes: 3 * GB, swapFreeBytes: 1 * GB, totalBytes: 8 * GB }, 2), null)
  })

  it('names how many sessions actually fit', () => {
    const warning = launchMemoryWarning({ freeBytes: 2.5 * GB, swapFreeBytes: 1 * GB, totalBytes: 8 * GB }, 6)
    assert.match(warning ?? '', /2\.5 GB RAM is free/)
    assert.match(warning ?? '', /start 1 more agent safely/)
  })

  it('says so when not even one session fits', () => {
    assert.match(launchMemoryWarning({ freeBytes: 0.8 * GB, totalBytes: 8 * GB }, 1) ?? '', /not enough memory/)
  })

  it('says nothing when memory could not be measured', () => {
    assert.equal(launchMemoryWarning({ freeBytes: 0, totalBytes: 0 }, 4), null)
    assert.equal(launchMemoryWarning({ freeBytes: Number.NaN, totalBytes: 8 * GB }, 4), null)
    assert.equal(launchMemoryWarning({ freeBytes: -1, totalBytes: 8 * GB }, 4), null)
  })

  it('says nothing when nothing is being launched', () => {
    assert.equal(launchMemoryWarning({ freeBytes: 0.2 * GB, totalBytes: 8 * GB }, 0), null)
  })
})
