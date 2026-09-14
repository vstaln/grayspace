import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKSPACE_FOLDER_NAME,
  ensureFolderStore,
  forgetFolderStore,
  readFolderWorkspaces,
  removeFolderSessions,
  workspaceListFile,
  workspaceSessionFile,
  writeFolderWorkspaces
} from './workspaceFolderStore.ts'

function makeFolder(): string {
  return mkdtempSync(join(tmpdir(), 'orcspace-folder-store-'))
}

function withFolder(run: (folder: string) => void): void {
  const folder = makeFolder()
  try {
    run(folder)
  } finally {
    forgetFolderStore(folder)
    rmSync(folder, { recursive: true, force: true })
  }
}

const ONE = { id: 'code-abc123', name: 'Workspace 1', createdAt: 1_700_000_000_000 }
const TWO = { id: 'code-def456', name: 'Backend', createdAt: 1_700_000_100_000 }

describe('workspaceFolderStore - where things go', () => {
  test('the store sits in the project folder', () => {
    withFolder((folder) => {
      assert.equal(workspaceListFile(folder), join(folder, WORKSPACE_FOLDER_NAME, 'workspaces.json'))
      assert.equal(
        workspaceSessionFile(folder, 'code-abc123'),
        join(folder, WORKSPACE_FOLDER_NAME, 'sessions', 'code-abc123.json')
      )
    })
  })

  test('with no folder there is nothing to write to', () => {
    assert.equal(workspaceListFile(undefined), null)
    assert.equal(workspaceSessionFile(undefined, 'code-abc123'), null)
    assert.equal(ensureFolderStore(''), false)
  })

  test('an id that is not a file name is refused', () => {
    withFolder((folder) => {
      assert.equal(workspaceSessionFile(folder, '../escape'), null)
      assert.equal(workspaceSessionFile(folder, 'a/b'), null)
      assert.equal(workspaceSessionFile(folder, ''), null)
    })
  })

  test('the store ignores itself so the project stays clean', () => {
    withFolder((folder) => {
      assert.equal(ensureFolderStore(folder), true)
      const ignore = join(folder, WORKSPACE_FOLDER_NAME, '.gitignore')
      assert.ok(existsSync(ignore))
      assert.match(readFileSync(ignore, 'utf8'), /^\*$/m)
    })
  })

  test('a .gitignore the user removed is not written again', () => {
    withFolder((folder) => {
      ensureFolderStore(folder)
      const ignore = join(folder, WORKSPACE_FOLDER_NAME, '.gitignore')
      rmSync(ignore)
      forgetFolderStore(folder)
      ensureFolderStore(folder)
      assert.equal(existsSync(ignore), false)
    })
  })
})

describe('workspaceFolderStore - reading and writing', () => {
  test('what was written comes back', () => {
    withFolder((folder) => {
      assert.equal(writeFolderWorkspaces(folder, [ONE, TWO], TWO.id), true)
      assert.deepEqual(readFolderWorkspaces(folder), { workspaces: [ONE, TWO], activeId: TWO.id })
    })
  })

  test('a folder that carries nothing reads as null, not as empty', () => {
    withFolder((folder) => {
      assert.equal(readFolderWorkspaces(folder), null)
    })
  })

  test('an active id naming no workspace falls back to the first', () => {
    withFolder((folder) => {
      writeFolderWorkspaces(folder, [ONE, TWO], 'code-gone')
      assert.equal(readFolderWorkspaces(folder)?.activeId, ONE.id)
    })
  })

  test('rows that are not workspaces are dropped, not trusted', () => {
    withFolder((folder) => {
      ensureFolderStore(folder)
      writeFileSync(
        workspaceListFile(folder)!,
        JSON.stringify({
          workspaces: [ONE, { id: '../escape', name: 'Bad' }, { id: 'code-x', name: '' }, null],
          activeId: ONE.id
        })
      )
      assert.deepEqual(readFolderWorkspaces(folder)?.workspaces, [ONE])
    })
  })

  test('a corrupt file reads as nothing rather than throwing', () => {
    withFolder((folder) => {
      ensureFolderStore(folder)
      writeFileSync(workspaceListFile(folder)!, '{ not json')
      assert.equal(readFolderWorkspaces(folder), null)
    })
  })

  test('the last workspace leaving takes the file with it', () => {
    withFolder((folder) => {
      writeFolderWorkspaces(folder, [ONE], ONE.id)
      assert.ok(existsSync(workspaceListFile(folder)!))
      assert.equal(writeFolderWorkspaces(folder, [], ''), true)
      assert.equal(existsSync(workspaceListFile(folder)!), false)
    })
  })

  test('deleting a workspace takes its sessions file', () => {
    withFolder((folder) => {
      ensureFolderStore(folder)
      const file = workspaceSessionFile(folder, ONE.id)!
      writeFileSync(file, '{"sessions":[]}')
      removeFolderSessions(folder, ONE.id)
      assert.equal(existsSync(file), false)
      // A second removal is not an error.
      removeFolderSessions(folder, ONE.id)
    })
  })

  test('a folder that cannot be written to says so instead of throwing', () => {
    const folder = makeFolder()
    try {
      // A file where the store directory would go: creating it must fail.
      writeFileSync(join(folder, WORKSPACE_FOLDER_NAME), 'in the way')
      assert.equal(ensureFolderStore(folder), false)
      assert.equal(writeFolderWorkspaces(folder, [ONE], ONE.id), false)
      assert.equal(readFolderWorkspaces(folder), null)
    } finally {
      forgetFolderStore(folder)
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
