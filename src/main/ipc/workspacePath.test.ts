import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { authorizeWorkspacePath } from './workspacePath.ts'

test('authorizes only the active or recent canonical workspace', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-workspace-path-'))
  const active = join(root, 'active')
  const recent = join(root, 'recent')
  const other = join(root, 'other')
  fs.mkdirSync(active)
  fs.mkdirSync(recent)
  fs.mkdirSync(other)
  try {
    assert.equal(authorizeWorkspacePath(active, active, [{ path: recent }])?.canonical, active)
    assert.equal(authorizeWorkspacePath(recent, active, [{ path: recent }])?.canonical, recent)
    assert.equal(authorizeWorkspacePath(other, active, [{ path: recent }]), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('canonicalizes an approved symlink and rejects one escaping it', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'orcspace-workspace-link-'))
  const approved = join(root, 'approved')
  const outside = join(root, 'outside')
  fs.mkdirSync(approved)
  fs.mkdirSync(outside)
  const approvedLink = join(root, 'approved-link')
  const escapeLink = join(approved, 'escape-link')
  try {
    try {
      fs.symlinkSync(approved, approvedLink, process.platform === 'win32' ? 'junction' : 'dir')
      fs.symlinkSync(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      console.warn('[test] skipping: could not create workspace symlink', error)
      return
    }
    assert.equal(authorizeWorkspacePath(approvedLink, approved, [])?.canonical, fs.realpathSync(approved))
    assert.equal(authorizeWorkspacePath(escapeLink, approved, []), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
