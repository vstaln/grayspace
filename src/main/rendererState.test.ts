import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RendererStateStore, isDurableRendererKey } from './rendererState.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): { file: string; value: RendererStateStore } {
  const root = mkdtempSync(join(tmpdir(), 'orcspace-renderer-state-'))
  roots.push(root)
  const file = join(root, 'renderer-state.json')
  return { file, value: new RendererStateStore(file) }
}

describe('RendererStateStore', () => {
  it('persists widget content and reloads it from disk', () => {
    const first = store()
    assert.equal(first.value.set('orcspace-music-playlists:music-1', '[{"name":"Saved"}]'), true)
    assert.equal(first.value.set('orcspace-links:links-1', '[{"url":"https://example.com"}]'), true)
    first.value.flush()

    const second = new RendererStateStore(first.file)
    assert.deepEqual(second.snapshot().values, {
      'orcspace-music-playlists:music-1': '[{"name":"Saved"}]',
      'orcspace-links:links-1': '[{"url":"https://example.com"}]'
    })
  })

  it('removes deleted widget state from the durable copy', () => {
    const target = store()
    target.value.set('orcspace-timer:timer-1', '{"remaining":10}')
    assert.equal(target.value.remove('orcspace-timer:timer-1'), true)
    target.value.flush()
    assert.deepEqual(JSON.parse(readFileSync(target.file, 'utf8')).values, {})
  })

  it('only accepts bounded OrcSpace-owned keys', () => {
    const target = store()
    assert.equal(isDurableRendererKey('workspace-theme'), true)
    assert.equal(target.value.set('foreign-key', 'value'), false)
    assert.equal(target.value.set('orcspace-chat:huge', 'x'.repeat(1024 * 1024 + 1)), false)
    assert.deepEqual(target.value.snapshot().values, {})
  })
})
