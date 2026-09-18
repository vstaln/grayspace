import * as os from 'node:os'
import { resolve } from 'node:path'

/**
 * Which directory a terminal comes back up in.
 *
 * A terminal's cwd is persisted with its scrollback so a restored session
 * lands where it left off. That is right for a directory somebody chose, and
 * wrong for the one it fell back to: a terminal opened before any folder was
 * open gets the home directory, that value is snapshotted, and from then on it
 * wins over the workspace on every restore — so the terminal stays in the home
 * directory for good, even after the user opens a project.
 *
 * The visible cost is not the prompt. Agent CLIs scope their history by
 * working directory (opencode keys its sessions on the git worktree), so a
 * terminal stuck in the home directory quietly writes its conversations into a
 * different project from the one the user is looking at — and the same agent
 * started from a normal shell in the project cannot find any of them.
 *
 * So a saved directory is honoured unless it is the fallback itself, which
 * nobody chose and which the open workspace should supersede.
 */
export function preferredTerminalCwd(input: {
  /** Explicitly requested by the caller (an agent, or the CLI). Always wins. */
  requested?: string
  /** Remembered from this terminal's previous session. */
  saved?: string
  /** The folder currently open in the app, if any. */
  workspace?: string
  /** Overridable for tests; the fallback `resolveCwd` uses. */
  home?: string
}): string | undefined {
  const { requested, saved, workspace } = input
  if (requested) return requested
  if (!workspace) return saved
  if (!saved) return workspace
  return isSamePath(saved, input.home ?? os.homedir()) ? workspace : saved
}

function isSamePath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value)
    return process.platform === 'win32' || process.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved
  }
  try {
    return normalize(a) === normalize(b)
  } catch {
    return false
  }
}
