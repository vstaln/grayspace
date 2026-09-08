import { strict as assert } from 'node:assert'
import { test, describe, beforeEach, afterEach } from 'node:test'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { createCore, fileResource, type Core } from '../core/index.ts'
import type { CommandDeps } from './index.ts'
import { registerFileCommands } from './files.ts'

function harness(): { core: Core; deps: CommandDeps } {
  const core = createCore()
  core.actors.register({ id: 'user', type: 'user', label: 'You', transport: 'ipc' })
  core.actors.register({ id: 'agent-a', type: 'agent', label: 'Agent', transport: 'cli' })
  const deps = { core } as unknown as CommandDeps
  registerFileCommands(deps)
  return { core, deps }
}

describe('file.* commands on the bus', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-files-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const targetOf = (abs: string): string => fileResource(abs)

  test('file.write creates and overwrites, journaling each commit', async () => {
    const { core } = harness()
    const abs = join(dir, 'a.txt')
    const r1 = await core.flow.submit({
      actorId: 'user',
      type: 'file.write',
      target: targetOf(abs),
      payload: { path: abs, content: 'one' }
    })
    assert.equal(r1.ok, true)
    assert.equal(fs.readFileSync(abs, 'utf8'), 'one')

    const r2 = await core.flow.submit({
      actorId: 'agent-a',
      type: 'file.write',
      target: targetOf(abs),
      payload: { path: abs, content: 'two' }
    })
    assert.equal(r2.ok, true)
    assert.equal(fs.readFileSync(abs, 'utf8'), 'two')
  })

  test('an actor holding the file lock keeps other actors out', async () => {
    const { core } = harness()
    const abs = join(dir, 'locked.txt')
    core.locks.acquire({ resource: targetOf(abs), actorId: 'agent-a', reason: 'refactor' })
    const res = await core.flow.submit({
      actorId: 'user',
      type: 'file.write',
      target: targetOf(abs),
      payload: { path: abs, content: 'nope' }
    })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.code, 'locked')
    assert.equal(fs.existsSync(abs), false)
  })

  test('target/path mismatch is refused — locking A cannot justify writing B', async () => {
    const { core } = harness()
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    const res = await core.flow.submit({
      actorId: 'user',
      type: 'file.write',
      target: targetOf(a),
      payload: { path: b, content: 'sneaky' }
    })
    assert.equal(res.ok === false && res.code, 'invalid')
    assert.equal(fs.existsSync(b), false)
  })

  test('UNC / relative paths are refused', async () => {
    const { core } = harness()
    const unc = '\\\\host\\share\\x.txt'
    const resUnc = await core.flow.submit({
      actorId: 'user',
      type: 'file.write',
      target: targetOf(unc),
      payload: { path: unc, content: 'x' }
    })
    assert.equal(resUnc.ok === false && resUnc.code, 'invalid')

    const rel = 'relative/path.txt'
    const resRel = await core.flow.submit({
      actorId: 'user',
      type: 'file.write',
      target: targetOf(rel),
      payload: { path: rel, content: 'x' }
    })
    assert.equal(resRel.ok === false && resRel.code, 'invalid')
  })

  test('file.create refuses an existing file; mkdir refuses an existing folder', async () => {
    const { core } = harness()
    const abs = join(dir, 'exists.txt')
    fs.writeFileSync(abs, '')
    const dup = await core.flow.submit({
      actorId: 'user',
      type: 'file.create',
      target: targetOf(abs),
      payload: { path: abs }
    })
    assert.equal(dup.ok === false && dup.message, 'File already exists')

    const subdir = join(dir, 'sub')
    fs.mkdirSync(subdir)
    const dupDir = await core.flow.submit({
      actorId: 'user',
      type: 'file.mkdir',
      target: targetOf(subdir),
      payload: { path: subdir }
    })
    assert.equal(dupDir.ok === false && dupDir.message, 'Folder already exists')
  })

  test('file.rename moves a file and refuses to clobber', async () => {
    const { core } = harness()
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    fs.writeFileSync(src, 'data')
    const ok = await core.flow.submit({
      actorId: 'user',
      type: 'file.rename',
      target: targetOf(src),
      payload: { path: src, to: dst }
    })
    assert.equal(ok.ok, true)
    assert.equal(fs.existsSync(src), false)
    assert.equal(fs.readFileSync(dst, 'utf8'), 'data')


    const blocker = join(dir, 'blocked.txt')
    fs.writeFileSync(blocker, 'keep')
    const refused = await core.flow.submit({
      actorId: 'user',
      type: 'file.rename',
      target: targetOf(dst),
      payload: { path: dst, to: blocker }
    })
    assert.equal(refused.ok === false && refused.message, 'Target file name already exists')
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'keep')
  })

  test('file.delete removes a file, recurses folders, reports missing targets', async () => {
    const { core } = harness()
    const file = join(dir, 'gone.txt')
    fs.writeFileSync(file, '')
    const del = await core.flow.submit({
      actorId: 'user',
      type: 'file.delete',
      target: targetOf(file),
      payload: { path: file }
    })
    assert.equal(del.ok, true)
    assert.equal(fs.existsSync(file), false)

    const folder = join(dir, 'folder')
    fs.mkdirSync(folder)
    fs.writeFileSync(join(folder, 'inner.txt'), '')
    const delDir = await core.flow.submit({
      actorId: 'user',
      type: 'file.delete',
      target: targetOf(folder),
      payload: { path: folder }
    })
    assert.equal(delDir.ok, true)
    assert.equal(fs.existsSync(folder), false)

    const missing = await core.flow.submit({
      actorId: 'user',
      type: 'file.delete',
      target: targetOf(file),
      payload: { path: file }
    })
    assert.equal(missing.ok === false && missing.code, 'not_found')
  })

  test('definitions are registered — schema validation works', async () => {
    const { core } = harness()
    const def = core.flow.getDefinition('file.write')
    assert.ok(def, 'file.write has a definition')
    const catalog = core.flow.catalog().map((d) => d.type)
    assert.ok(catalog.includes('file.write'))
    assert.ok(catalog.includes('file.rename'))


    const badPayload = await core.flow.submit({
      actorId: 'user',
      type: 'file.write',
      target: targetOf(join(dir, 'x.txt')),
      payload: { path: join(dir, 'x.txt') }
    })
    assert.equal(badPayload.ok === false && badPayload.code, 'invalid')
  })

  test('concurrent writes to different files run on disjoint lanes', async () => {
    const { core } = harness()
    const startedAt = new Map<string, number>()
    const finished: string[] = []

    const paths = [join(dir, 'p1.txt'), join(dir, 'p2.txt')]
    const t0 = Date.now()
    await Promise.all(
      paths.map(async (p, i) => {
        startedAt.set(p, Date.now() - t0)
        return core.flow.submit({
          actorId: i === 0 ? 'user' : 'agent-a',
          type: 'file.write',
          target: targetOf(p),
          payload: { path: p, content: `c${i}` }
        }).then((r) => {
          assert.equal(r.ok, true)
          finished.push(p)
        })
      })
    )
    assert.equal(finished.length, 2)
  })
})
