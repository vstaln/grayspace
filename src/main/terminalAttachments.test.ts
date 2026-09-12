import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentAgent, imagePasteShortcut, insertAttachments, isTerminalPasteShortcut, type AttachmentFile } from '../renderer/src/lib/terminalAttachments.ts'

function fixture() {
  const pasted: string[] = [], written: string[] = [], errors: string[] = [], saved: string[] = []
  let staged = 0
  const deps = {
    getPath: (_file: AttachmentFile) => '',
    save: async (_bytes: Uint8Array, ext: string) => { saved.push(ext); return { path: `C:/scratch/file.${ext}` } },
    stage: async (_bytes: Uint8Array): Promise<{ ok: true } | { error: string }> => { staged++; return { ok: true } },
    paste: (text: string) => { pasted.push(text) },
    write: (text: string) => { written.push(text) },
    report: (text: string) => { errors.push(text) },
    alive: () => true
  }
  return { deps, pasted, written, errors, saved, staged: () => staged }
}
const file = (name: string, type = ''): AttachmentFile => ({ name, type, size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })

test('paste shortcuts support English/Russian layouts and leave Windows history to the OS', () => {
  const key = { key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
  for (const isMac of [false, true]) {
    assert.equal(isTerminalPasteShortcut({ ...key, altKey: true }, isMac), true)
    assert.equal(isTerminalPasteShortcut({ ...key, ctrlKey: true }, isMac), true)
    assert.equal(isTerminalPasteShortcut({ ...key, ctrlKey: true, shiftKey: true }, isMac), true)
    assert.equal(isTerminalPasteShortcut({ ...key, key: 'м', altKey: true }, isMac), true)
    assert.equal(isTerminalPasteShortcut({ ...key, key: 'Insert', code: 'Insert', keyCode: 45, shiftKey: true }, isMac), true)
    assert.equal(isTerminalPasteShortcut(key, isMac), false)
  }
  assert.equal(isTerminalPasteShortcut({ ...key, metaKey: true }, false), false)
  assert.equal(isTerminalPasteShortcut({ ...key, metaKey: true }, true), true)
})

test('Windows Claude and Kimi receive Alt+V; other supported platforms receive Ctrl+V', () => {
  for (const agent of ['claude', 'kimi', 'grok', 'commandcode', 'pi']) {
    assert.equal(imagePasteShortcut(agent, 'win32'), '\x1bv')
    assert.equal(imagePasteShortcut(agent, 'darwin'), '\x16')
    assert.equal(imagePasteShortcut(agent, 'linux'), '\x16')
  }
  for (const agent of ['codex', 'opencode', 'cursor', 'cursor-agent']) assert.equal(imagePasteShortcut(agent, 'win32'), '\x16')
  for (const agent of ['custom', undefined]) assert.equal(imagePasteShortcut(agent, 'win32'), null)
})
test('single image stages actual bytes before invoking native image paste', async () => {
  const f = fixture()
  await insertAttachments([file('screen.PNG')], '\x1bv', f.deps)
  assert.equal(f.staged(), 1)
  assert.deepEqual(f.written, ['\x1bv'])
  assert.deepEqual(f.pasted, [])
})
test('Antigravity and agy retain native image attachment instead of pasting a path', async () => {
  for (const agent of ['antigravity', 'agy', 'agy.cmd']) {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const f = fixture()
      await insertAttachments([file('screenshot.png', 'image/png')], imagePasteShortcut(agent, platform), f.deps)
      assert.equal(f.staged(), 1)
      assert.deepEqual(f.written, ['\x16'])
      assert.deepEqual(f.pasted, [])
    }
  }
})

test('unsupported image decoder falls back to a saved path', async () => {
  const f = fixture()
  f.deps.stage = async () => ({ error: 'Unsupported image format' })
  await insertAttachments([file('drawing.svg')], '\x16', f.deps)
  assert.deepEqual(f.saved, ['svg'])
  assert.deepEqual(f.pasted, ['"C:/scratch/file.svg" '])
})
test('MP3 without a native path is saved intact as audio, never staged as image', async () => {
  const f = fixture()
  await insertAttachments([file('record.mp3', 'audio/mpeg')], '\x16', f.deps)
  assert.deepEqual(f.saved, ['mp3'])
  assert.deepEqual(f.pasted, ['"C:/scratch/file.mp3" '])
  assert.equal(f.staged(), 0)
})
test('multi-image drop preserves distinct paths without clipboard overwrite', async () => {
  const f = fixture()
  f.deps.getPath = (value) => `C:/my images/${value.name}`
  await insertAttachments([file('one.png'), file('two.jpg')], '\x16', f.deps)
  assert.deepEqual(f.pasted, ['"C:/my images/one.png" ', '"C:/my images/two.jpg" '])
  assert.equal(f.staged(), 0)
})
test('all fallback CLIs receive files through paste without executing them', async () => {
  for (const agent of ['custom']) {
    const f = fixture()
    await insertAttachments([file('image.png')], imagePasteShortcut(agent, 'win32'), f.deps)
    assert.equal(f.pasted.length, 1)
    assert.deepEqual(f.written, [])
  }
})

test('launcher commands identify custom agents without treating ordinary prompts as CLI names', () => {
  assert.equal(attachmentAgent('commandcode --resume'), 'commandcode')
  assert.equal(attachmentAgent('"C:\\Program Files\\pi.exe"'), 'pi')
  assert.equal(attachmentAgent('cursor-agent --resume'), 'cursor')
  assert.equal(attachmentAgent('fix this error'), undefined)
  assert.equal(attachmentAgent('"C:\\codex-tools\\claude.exe" --resume'), 'claude')
  assert.equal(attachmentAgent('echo codex'), undefined)
})

test('files with inaccessible native paths fall back to their original bytes', async () => {
  const f = fixture()
  f.deps.getPath = () => { throw new Error('Not a native File') }
  await insertAttachments([file('report.txt', 'text/plain')], null, f.deps)
  assert.deepEqual(f.saved, ['txt'])
  assert.deepEqual(f.pasted, ['"C:/scratch/file.txt" '])
  assert.deepEqual(f.errors, [])
})
test('a failed file does not discard the rest of the batch', async () => {
  const f = fixture()
  const bad = { ...file('broken.png'), arrayBuffer: async (): Promise<ArrayBuffer> => { throw new Error('Read failed') } }
  await insertAttachments([bad, file('song.mp3')], '\x16', f.deps)
  assert.equal(f.errors.length, 1)
  assert.equal(f.pasted.length, 1)
})
test('disposed terminal receives no input', async () => {
  const f = fixture()
  f.deps.alive = () => false
  await insertAttachments([file('image.png')], '\x16', f.deps)
  assert.equal(f.staged(), 0)
  assert.deepEqual(f.written, [])
})
test('oversized virtual files are rejected before reading', async () => {
  const f = fixture()
  let read = false
  await insertAttachments([{ ...file('big.mp3'), size: 257 * 1024 * 1024, arrayBuffer: async () => { read = true; return new ArrayBuffer(0) } }], null, f.deps)
  assert.equal(read, false)
  assert.equal(f.errors.length, 1)
})
test('control characters in dropped paths never reach terminal input', async () => {
  const f = fixture()
  f.deps.getPath = () => 'C:/file\rcommand.mp3'
  await insertAttachments([file('song.mp3')], null, f.deps)
  assert.deepEqual(f.pasted, [])
  assert.equal(f.errors.length, 1)
})
