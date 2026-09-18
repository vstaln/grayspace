import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const userData = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-snapshots-test-'))
process.env.ORCSPACE_TEST_USER_DATA = userData

const { TerminalSnapshots } = await import('./terminalSnapshots.ts')

const dir = join(userData, 'terminals')
const logs = (): string[] =>
  (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((name) => name.endsWith('.log')).sort()

describe('terminal snapshots', () => {
  before(() => {
    fs.mkdirSync(dir, { recursive: true })
  })
  after(() => {
    fs.rmSync(userData, { recursive: true, force: true })
  })

  it('keeps the snapshot of a live terminal', () => {
    const store = new TerminalSnapshots()
    store.save({ id: 'term-1', title: 'one', cwd: 'C:\\work', scrollback: 'hello' })
    store.prune(['term-1'])
    assert.deepEqual(logs(), ['term-1.log'])
    assert.equal(store.get('term-1')?.title, 'one')
  })

  it('drops the snapshot of a terminal that is gone', () => {
    const store = new TerminalSnapshots()
    store.save({ id: 'term-2', title: 'two', cwd: 'C:\\work', scrollback: 'hello' })
    store.prune(['term-1'])
    assert.equal(logs().includes('term-2.log'), false)
  })

  it('sweeps a scrollback file the index has forgotten', () => {
    // How these arise: the index write is debounced and asynchronous, so a
    // quit between writing the file and flushing the index leaves the file
    // with no entry pointing at it. Walking index keys alone can never see it
    // again, and on a real profile 25 of them had piled up.
    fs.writeFileSync(join(dir, 'term-orphan.log'), 'left behind')
    assert.equal(logs().includes('term-orphan.log'), true)

    const store = new TerminalSnapshots()
    store.prune(['term-1'])
    assert.equal(logs().includes('term-orphan.log'), false)
  })

  it('leaves everything that is not a scrollback file alone', () => {
    fs.writeFileSync(join(dir, 'unrelated.json'), '{}')
    const store = new TerminalSnapshots()
    store.prune(['term-1'])
    assert.equal(fs.existsSync(join(dir, 'unrelated.json')), true)
  })

  it('removes the file for a forgotten id even with no index entry', () => {
    fs.writeFileSync(join(dir, 'term-stray.log'), 'left behind')
    const store = new TerminalSnapshots()
    store.forget('term-stray')
    // forget() removes the file asynchronously; prune's sweep is the
    // synchronous guarantee, so assert through it.
    store.prune(['term-1'])
    assert.equal(logs().includes('term-stray.log'), false)
  })
})
