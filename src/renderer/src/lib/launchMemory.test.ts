import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { launchMemoryWarning } from './launchMemory.ts'

const GB = 1024 * 1024 * 1024

describe('launch memory warning', () => {
  it('stays quiet when there is room for every session', () => {
    assert.equal(launchMemoryWarning(8 * GB, 6), null)
    assert.equal(launchMemoryWarning(3 * GB, 2), null)
  })

  it('names how many sessions actually fit', () => {
    const warning = launchMemoryWarning(2.5 * GB, 6)
    assert.match(warning ?? '', /2\.5 GB of memory free/)
    assert.match(warning ?? '', /about 1 at a time is safe/)
  })

  it('says so when not even one session fits', () => {
    assert.match(launchMemoryWarning(0.8 * GB, 1) ?? '', /even one may fail/)
  })

  it('says nothing when memory could not be measured', () => {
    assert.equal(launchMemoryWarning(0, 4), null)
    assert.equal(launchMemoryWarning(Number.NaN, 4), null)
    assert.equal(launchMemoryWarning(-1, 4), null)
  })

  it('says nothing when nothing is being launched', () => {
    assert.equal(launchMemoryWarning(0.2 * GB, 0), null)
  })
})
