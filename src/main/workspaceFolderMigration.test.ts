import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKSPACE_FOLDER_NAME, forgetFolderStore } from './workspaceFolderStore.ts'

if (!process.env.ORCSPACE_TEST_USER_DATA) {
  process.env.ORCSPACE_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'orcspace-folder-migration-'))
}

/**
 * The stores reach for electron at import time. A checkout whose electron
 * install is broken should say "not run here" rather than fail a test about
 * where workspaces are stored.
 */
const stores = await (async () => {
  try {
    const [appState, codeState] = await Promise.all([import('./appState.ts'), import('./codeState.ts')])
    return { AppState: appState.AppState, CodeStore: codeState.CodeStore }
  } catch {
    return null
  }
})()

function project(): string {
  return mkdtempSync(join(tmpdir(), 'orcspace-project-'))
}

function listFile(folder: string): string {
  return join(folder, WORKSPACE_FOLDER_NAME, 'workspaces.json')
}

function sessionFile(folder: string, workspaceId: string): string {
  return join(folder, WORKSPACE_FOLDER_NAME, 'sessions', `${workspaceId}.json`)
}

const SESSION = {
  id: 'code-1',
  agentId: 'antigravity',
  label: 'Antigravity',
  command: 'agy --conversation 11111111-1111-4111-8111-111111111111',
  title: 'Michael'
}

describe('workspaces live in the folder they belong to', () => {
  test('a folder gets its workspaces written into it', (t) => {
    if (!stores) return t.skip('electron unavailable')
    const folder = project()
    try {
      const state = new stores.AppState()
      state.setWorkspaceDir(folder)
      const first = state.codeWorkspaceState(folder)
      assert.equal(first.workspaces.length, 1)
      assert.ok(existsSync(listFile(folder)))
      const carried = JSON.parse(readFileSync(listFile(folder), 'utf8'))
      assert.deepEqual(carried.workspaces.map((w: { name: string }) => w.name), ['Workspace 1'])
      assert.equal(carried.activeId, first.activeId)
      assert.ok(existsSync(join(folder, WORKSPACE_FOLDER_NAME, '.gitignore')))

      const created = state.createCodeWorkspace(folder, 'Backend')
      assert.ok(!('error' in created))
      const afterCreate = JSON.parse(readFileSync(listFile(folder), 'utf8'))
      assert.deepEqual(afterCreate.workspaces.map((w: { name: string }) => w.name), ['Workspace 1', 'Backend'])
    } finally {
      forgetFolderStore(folder)
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('a workspace keeps its sessions beside the project', (t) => {
    if (!stores) return t.skip('electron unavailable')
    const folder = project()
    try {
      const state = new stores.AppState()
      const active = state.codeWorkspaceState(folder).activeId
      const code = new stores.CodeStore()
      code.setWorkspaceScope(state.activeCodeWorkspaceScope(folder), undefined, folder)
      code.save({ sessions: [SESSION] }, true)
      const stored = JSON.parse(readFileSync(sessionFile(folder, active), 'utf8'))
      assert.deepEqual(stored.sessions.map((s: { title: string }) => s.title), ['Michael'])
    } finally {
      forgetFolderStore(folder)
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('another install reads the folder rather than starting it over', (t) => {
    if (!stores) return t.skip('electron unavailable')
    const folder = project()
    const first = process.env.ORCSPACE_TEST_USER_DATA!
    const second = mkdtempSync(join(tmpdir(), 'orcspace-other-install-'))
    try {
      const state = new stores.AppState()
      state.setWorkspaceDir(folder)
      state.createCodeWorkspace(folder, 'Backend')
      const active = state.codeWorkspaceState(folder).activeId
      const code = new stores.CodeStore()
      code.setWorkspaceScope(state.activeCodeWorkspaceScope(folder), undefined, folder)
      code.save({ sessions: [SESSION] }, true)

      process.env.ORCSPACE_TEST_USER_DATA = second
      const fresh = new stores.AppState()
      const adopted = fresh.codeWorkspaceState(folder)
      assert.deepEqual(adopted.workspaces.map((w: { name: string }) => w.name), ['Workspace 1', 'Backend'])
      assert.equal(adopted.activeId, active)
      const freshCode = new stores.CodeStore()
      freshCode.setWorkspaceScope(fresh.activeCodeWorkspaceScope(folder), undefined, folder)
      assert.deepEqual(freshCode.load().sessions.map((s: { title?: string }) => s.title), ['Michael'])
    } finally {
      process.env.ORCSPACE_TEST_USER_DATA = first
      forgetFolderStore(folder)
      rmSync(folder, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  test('sessions recorded before the folder store are carried into it', async (t) => {
    if (!stores) return t.skip('electron unavailable')
    const folder = project()
    try {
      const state = new stores.AppState()
      const active = state.codeWorkspaceState(folder).activeId
      // As an older build wrote it: the app data directory, folder untouched.
      const legacy = new stores.CodeStore()
      legacy.setWorkspaceScope(state.activeCodeWorkspaceScope(folder), undefined, undefined)
      legacy.save({ sessions: [SESSION] }, true)
      assert.equal(existsSync(sessionFile(folder, active)), false)

      const migrated = new stores.CodeStore()
      migrated.setWorkspaceScope(state.activeCodeWorkspaceScope(folder), undefined, folder)
      assert.deepEqual(migrated.load().sessions.map((s: { title?: string }) => s.title), ['Michael'])
      // Adopted sessions are written out without waiting for a change.
      migrated.flush()
      assert.ok(existsSync(sessionFile(folder, active)))
    } finally {
      forgetFolderStore(folder)
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('only the folder that is open gets a store, not every folder listed', (t) => {
    if (!stores) return t.skip('electron unavailable')
    const open = project()
    const listed = project()
    try {
      const state = new stores.AppState()
      state.setWorkspaceDir(open)
      // What the recent list does on every open of the workspace picker.
      state.codeWorkspaceState(listed)
      state.codeWorkspaceState(open)
      assert.ok(existsSync(join(open, WORKSPACE_FOLDER_NAME)))
      assert.equal(existsSync(join(listed, WORKSPACE_FOLDER_NAME)), false)

      // Asking for one on purpose still writes it.
      state.createCodeWorkspace(listed, 'Explicit')
      assert.ok(existsSync(listFile(listed)))
    } finally {
      forgetFolderStore(open)
      forgetFolderStore(listed)
      rmSync(open, { recursive: true, force: true })
      rmSync(listed, { recursive: true, force: true })
    }
  })

  test('a folder that refuses the write keeps the sessions in the app data directory', (t) => {
    if (!stores) return t.skip('electron unavailable')
    const folder = project()
    try {
      const state = new stores.AppState()
      state.setWorkspaceDir(folder)
      const active = state.codeWorkspaceState(folder).activeId
      const code = new stores.CodeStore()
      code.setWorkspaceScope(state.activeCodeWorkspaceScope(folder), undefined, folder)

      // The sessions directory becomes a file: every write into it now fails,
      // the way a read-only checkout or a share that went away would.
      rmSync(join(folder, WORKSPACE_FOLDER_NAME, 'sessions'), { recursive: true, force: true })
      writeFileSync(join(folder, WORKSPACE_FOLDER_NAME, 'sessions'), 'in the way')

      code.save({ sessions: [SESSION] }, true)
      assert.equal(existsSync(sessionFile(folder, active)), false)
      // Nothing was lost: it is in memory, and the next read finds it on disk.
      assert.deepEqual(code.load().sessions.map((s: { title?: string }) => s.title), ['Michael'])
      const fallback = new stores.CodeStore()
      fallback.setWorkspaceScope(state.activeCodeWorkspaceScope(folder), undefined, undefined)
      assert.deepEqual(fallback.load().sessions.map((s: { title?: string }) => s.title), ['Michael'])
    } finally {
      forgetFolderStore(folder)
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('deleting a workspace takes its sessions and its entry', (t) => {
    if (!stores) return t.skip('electron unavailable')
    const folder = project()
    try {
      const state = new stores.AppState()
      state.setWorkspaceDir(folder)
      const active = state.codeWorkspaceState(folder).activeId
      const code = new stores.CodeStore()
      code.setWorkspaceScope(state.activeCodeWorkspaceScope(folder), undefined, folder)
      code.save({ sessions: [SESSION] }, true)
      assert.ok(existsSync(sessionFile(folder, active)))

      state.createCodeWorkspace(folder, 'Backend')
      const result = state.deleteCodeWorkspace(folder, active)
      assert.ok(!('error' in result))
      assert.equal(existsSync(sessionFile(folder, active)), false)
      const carried = JSON.parse(readFileSync(listFile(folder), 'utf8'))
      assert.deepEqual(carried.workspaces.map((w: { name: string }) => w.name), ['Backend'])
    } finally {
      forgetFolderStore(folder)
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
