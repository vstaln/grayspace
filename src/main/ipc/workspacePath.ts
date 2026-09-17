import * as fs from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { isLocalPath } from '../media.ts'

export interface WorkspacePathMatch {
  /** Canonical path used for filesystem operations. */
  canonical: string
  /** Path as it appears in app state, useful for recent-list mutations. */
  configured: string
}

type RecentWorkspace = string | { path?: unknown }

function canonicalDirectory(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length >= 1024 || !isAbsolute(value) || !isLocalPath(value)) return null
  try {
    const canonical = fs.realpathSync(resolve(value))
    return fs.statSync(canonical).isDirectory() ? canonical : null
  } catch {
    return null
  }
}

function sameCanonicalPath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    // resolve() already removes ordinary trailing separators while retaining
    // filesystem roots (for example C:\\ on Windows).
    const resolved = resolve(value)
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved
  }
  return normalize(a) === normalize(b)
}

function configuredPath(entry: unknown): unknown {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && 'path' in entry) return (entry as { path?: unknown }).path
  return undefined
}

/**
 * Resolve a renderer-supplied directory only when it is the active workspace
 * or one of the remembered recent workspaces. Realpath comparison prevents a
 * symlink inside an approved folder from redirecting a provider elsewhere.
 */
export function authorizeWorkspacePath(
  requested: unknown,
  active: unknown,
  recent: readonly RecentWorkspace[] = []
): WorkspacePathMatch | null {
  const requestedCanonical = canonicalDirectory(requested)
  if (!requestedCanonical) return null

  const candidates: unknown[] = [active, ...recent]
  for (const candidate of candidates) {
    const configured = configuredPath(candidate)
    const canonical = canonicalDirectory(configured)
    if (canonical && sameCanonicalPath(requestedCanonical, canonical)) {
      return { canonical: requestedCanonical, configured: typeof configured === 'string' ? configured : requestedCanonical }
    }
  }
  return null
}

/** Return the canonical active workspace for omitted optional directory input. */
export function canonicalActiveWorkspacePath(active: unknown): string | null {
  return canonicalDirectory(active)
}
