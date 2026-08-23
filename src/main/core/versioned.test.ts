import { strict as assert } from 'node:assert'
import { test, describe } from 'node:test'
import { VersionRegistry, stamp } from './versioned.ts'
import { fileResource, parseResource, resourceId } from './resources.ts'

describe('VersionRegistry', () => {
  test('an unknown object is at version 0, not 1', () => {
    const versions = new VersionRegistry('note')
    assert.equal(versions.current('nope'), 0)
    assert.equal(versions.versionOf('note:nope'), undefined)
  })

  test('every bump advances by one and is visible under the resource id', () => {
    const versions = new VersionRegistry('note')
    assert.equal(versions.bump('n1'), 1)
    assert.equal(versions.bump('n1'), 2)
    assert.equal(versions.versionOf('note:n1'), 2)
    assert.equal(versions.versionOf('note:n2'), undefined)
  })

  test('seeding restores persisted versions without advancing them', () => {
    const versions = new VersionRegistry('task')
    versions.seed([{ id: 't1', version: 7 }, { id: 't2' }])
    assert.equal(versions.current('t1'), 7)
    // A task saved before versions existed must not start at 0, or the first
    // client to read it could not send a baseVersion that ever matches.
    assert.equal(versions.current('t2'), 1)
  })

  test('forgetting an object drops its version with it', () => {
    const versions = new VersionRegistry('widget')
    versions.bump('w1')
    versions.forget('w1')
    assert.equal(versions.current('w1'), 0)
  })

  test('stamp attaches the next version to a fresh object', () => {
    const versions = new VersionRegistry('widget')
    const widget = stamp(versions, { id: 'w1', title: 'Terminal' }, 1234)
    assert.deepEqual(widget, { id: 'w1', title: 'Terminal', version: 1, updatedAt: 1234 })
  })
})

describe('resource ids', () => {
  test('a Windows path keeps its drive colon', () => {
    const parsed = parseResource(fileResource('C:\\src\\main\\index.ts'))
    assert.deepEqual(parsed, { scheme: 'file', id: 'C:/src/main/index.ts' })
  })

  test('two spellings of one path normalise to the same lock key', () => {
    assert.equal(fileResource('c:\\src\\a.ts'), fileResource('C:/src/a.ts'))
    assert.equal(fileResource('C:/Src/A.ts'), fileResource('C:/src/a.ts'))
    assert.equal(fileResource('src/a/'), fileResource('src/a'))
  })

  test('an unknown scheme is not a resource', () => {
    assert.equal(parseResource('secrets:everything'), null)
    assert.equal(parseResource('note'), null)
    assert.equal(resourceId('note', 'n1'), 'note:n1')
  })
})
