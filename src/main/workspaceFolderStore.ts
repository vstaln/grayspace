import * as fs from 'fs'
import { join, resolve } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage.ts'

/**
 * Workspaces kept next to the project they belong to.
 *
 * The app's own data directory used to be the only home for them, which meant
 * a folder carried none of its own setup: move the project, work on it from
 * another machine or another install, and the workspaces were gone. Keeping
 * them in `<project>/.orcspace-workspaces` makes the folder self-describing —
 * open it anywhere and the workspaces and their sessions come with it.
 *
 * The app data directory stays the fallback, not a second source of truth: a
 * folder that cannot be written to (a read-only checkout, a mounted share) or
 * no folder at all still works exactly as before.
 */

export const WORKSPACE_FOLDER_NAME = '.orcspace-workspaces'
export const WORKSPACE_LIST_FILE = 'workspaces.json'
export const WORKSPACE_SESSIONS_DIR = 'sessions'
export const FOLDER_SCHEMA_VERSION = 1

/**
 * Git sees this directory as ordinary project files, and it is per machine —
 * which terminal was open, which session was maximised. Ignoring itself keeps
 * it out of `git status` without editing the project's own `.gitignore`.
 * Delete this file to commit the workspaces and share them with the team.
 */
const GITIGNORE = `# OrcSpace keeps this folder's workspaces here.
# Delete this file to commit them instead.
*
`

export interface FolderWorkspace {
  id: string
  name: string
  createdAt: number
}

export interface FolderWorkspaces {
  workspaces: FolderWorkspace[]
  activeId: string
}

/** Ids reach the filesystem as names, so anything else is not one. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Whether a folder's store could be written, remembered per folder.
 *
 * Creating the directory and probing it costs a syscall or three, and the
 * stores ask on every read and every save. A folder's writability does not
 * change from under us in the course of a session often enough to pay that on
 * every call — and when it does, the write itself still fails safely.
 */
const writable = new Map<string, boolean>()

function normalizeFolder(folder: string | undefined | null): string {
  if (typeof folder !== 'string' || !folder.trim()) return ''
  try {
    return resolve(folder)
  } catch {
    return ''
  }
}

/** The store directory for a folder, without creating anything. */
export function folderStoreDir(folder: string | undefined | null): string | null {
  const root = normalizeFolder(folder)
  return root ? join(root, WORKSPACE_FOLDER_NAME) : null
}

/**
 * Creates the store directory the first time it is needed, and reports whether
 * it can be used at all. Cached, so the common path is a map lookup.
 */
export function ensureFolderStore(folder: string | undefined | null): boolean {
  const dir = folderStoreDir(folder)
  if (!dir) return false
  const known = writable.get(dir)
  if (known !== undefined) return known
  let ok = false
  try {
    // Only a directory we are creating gets the ignore file. Writing it back
    // into a store that already exists would undo a user who deleted it to
    // commit the workspaces on purpose.
    const fresh = !fs.existsSync(dir)
    fs.mkdirSync(join(dir, WORKSPACE_SESSIONS_DIR), { recursive: true })
    if (fresh) fs.writeFileSync(join(dir, '.gitignore'), GITIGNORE, 'utf8')
    ok = true
  } catch {
    // Read-only checkout, a share that went away, a permission the app does
    // not have: the app data directory keeps the workspaces instead.
    ok = false
  }
  writable.set(dir, ok)
  return ok
}

/** Forgets what is known about a folder — for tests, and for a folder that moved. */
export function forgetFolderStore(folder?: string | undefined | null): void {
  if (folder === undefined) {
    writable.clear()
    return
  }
  const dir = folderStoreDir(folder)
  if (dir) writable.delete(dir)
}

export function workspaceListFile(folder: string | undefined | null): string | null {
  const dir = folderStoreDir(folder)
  return dir ? join(dir, WORKSPACE_LIST_FILE) : null
}

/**
 * Where one workspace's sessions live. `null` for an id that has no business
 * being a file name, so a hand-edited state file cannot aim a write elsewhere.
 */
export function workspaceSessionFile(folder: string | undefined | null, workspaceId: string): string | null {
  const dir = folderStoreDir(folder)
  if (!dir || typeof workspaceId !== 'string' || !SAFE_ID.test(workspaceId)) return null
  return join(dir, WORKSPACE_SESSIONS_DIR, `${workspaceId}.json`)
}

function sanitizeWorkspace(raw: unknown): FolderWorkspace | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id.trim().slice(0, 128) : ''
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : ''
  if (!SAFE_ID.test(id) || !name) return null
  const createdAt = Number(item.createdAt)
  return { id, name, createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now() }
}

/**
 * The workspaces a folder carries, or `null` when it carries none — which is
 * what tells a caller to fall back to the app data directory rather than to
 * treat the folder as having had its workspaces deleted.
 */
export function readFolderWorkspaces(folder: string | undefined | null): FolderWorkspaces | null {
  const file = workspaceListFile(folder)
  if (!file) return null
  const raw = readStoreJson<Record<string, unknown>>(file, {})
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.workspaces)) return null
  const workspaces = raw.workspaces.map(sanitizeWorkspace).filter((w): w is FolderWorkspace => w !== null)
  if (workspaces.length === 0) return null
  const claimed = typeof raw.activeId === 'string' ? raw.activeId : ''
  const activeId = workspaces.some((w) => w.id === claimed) ? claimed : workspaces[0].id
  return { workspaces, activeId }
}

/** Returns false when the folder could not take the write; the caller keeps its own copy. */
export function writeFolderWorkspaces(
  folder: string | undefined | null,
  workspaces: readonly FolderWorkspace[],
  activeId: string
): boolean {
  const file = workspaceListFile(folder)
  if (!file) return false
  if (workspaces.length === 0) {
    // The folder has no workspaces left. An empty list file would read as
    // "carries nothing" anyway, so remove it rather than leave a husk that
    // outlives the directory's purpose.
    try {
      fs.rmSync(file, { force: true })
      fs.rmSync(`${file}.bak`, { force: true })
    } catch {
      // Nothing points at it either way.
    }
    return true
  }
  if (!ensureFolderStore(folder)) return false
  try {
    writeJsonAtomic(file, {
      schemaVersion: FOLDER_SCHEMA_VERSION,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, createdAt: w.createdAt })),
      activeId
    })
    return true
  } catch {
    // A folder that turned read-only mid-session: stop trusting it for writes.
    forgetFolderStore(folder)
    return false
  }
}

/** Removes one workspace's sessions file; a missing file is already the goal. */
export function removeFolderSessions(folder: string | undefined | null, workspaceId: string): void {
  const file = workspaceSessionFile(folder, workspaceId)
  if (!file) return
  try {
    fs.rmSync(file, { force: true })
    fs.rmSync(`${file}.bak`, { force: true })
  } catch {
    // Leaving a stale sessions file behind is harmless: nothing points at it.
  }
}
