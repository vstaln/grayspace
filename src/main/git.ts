import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)

export interface GitStatus {
  repo: boolean
  root?: string
  branch?: string
  /** Tracking branch, when the current branch has one. */
  upstream?: string
  ahead: number
  behind: number
  modified: number
  untracked: number
  staged: number
  conflicted: number
  lastCommit?: { hash: string; subject: string; at: number }
  error?: string
  readAt: number
}

const EMPTY = (extra: Partial<GitStatus> = {}): GitStatus => ({
  repo: false,
  ahead: 0,
  behind: 0,
  modified: 0,
  untracked: 0,
  staged: 0,
  conflicted: 0,
  readAt: Date.now(),
  ...extra
})

async function git(cwd: string, args: string[]): Promise<string> {
  // The git binary directly, never a shell: no quoting rules to get wrong on a
  // path with spaces, and nothing in a branch name can be interpreted.
  const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

/**
 * Repository status for the project folder.
 *
 * Read by running git, not by parsing what a terminal happens to have printed:
 * a PTY's scrollback is a rendering of a human-facing command, wrapped, paged
 * and coloured, and treating it as an API breaks the first time the user runs
 * something else in that shell.
 */
export async function readGitStatus(cwd: string | undefined): Promise<GitStatus> {
  if (!cwd) return EMPTY()
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    if (!root) return EMPTY()

    // -b gives the branch header; -z avoids quoting surprises in filenames.
    const porcelain = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal'])
    const entries = porcelain.split('\0').filter(Boolean)
    const header = entries[0]?.startsWith('##') ? entries[0] : ''
    const status = EMPTY({ repo: true, root, ...parseHeader(header) })

    for (const entry of entries.slice(header ? 1 : 0)) {
      const code = entry.slice(0, 2)
      if (code === '??') status.untracked += 1
      else if (code.includes('U') || code === 'AA' || code === 'DD') status.conflicted += 1
      else {
        if (code[0] !== ' ' && code[0] !== '?') status.staged += 1
        if (code[1] !== ' ' && code[1] !== '?') status.modified += 1
      }
    }

    const log = (await git(cwd, ['log', '-1', '--format=%H%x1f%s%x1f%ct'])).trim()
    if (log) {
      const [hash, subject, at] = log.split('\x1f')
      status.lastCommit = { hash: hash.slice(0, 8), subject, at: Number(at) * 1000 }
    }
    return status
  } catch (err) {
    const message = String((err as { stderr?: string }).stderr || (err as Error).message)
    // "not a git repository" is an ordinary answer, not a failure to report.
    if (/not a git repository/i.test(message)) return EMPTY()
    return EMPTY({ error: message.trim().slice(0, 300) })
  }
}

/** `## main...origin/main [ahead 2, behind 1]` */
function parseHeader(header: string): Partial<GitStatus> {
  if (!header) return {}
  const body = header.slice(2).trim()
  const [branches, tracking] = body.split(/\s+\[/)
  const [branch, upstream] = branches.split('...')
  const ahead = tracking?.match(/ahead (\d+)/)
  const behind = tracking?.match(/behind (\d+)/)
  return {
    branch: branch === 'No commits yet on ' + branch ? branch : branch?.replace(/^No commits yet on /, ''),
    upstream: upstream || undefined,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0
  }
}

/** Stages everything and commits. Callers must hold `git:repo` first. */
export async function commitAll(cwd: string, message: string): Promise<{ hash: string }> {
  await git(cwd, ['add', '-A'])
  await git(cwd, ['commit', '-m', message])
  const hash = (await git(cwd, ['rev-parse', 'HEAD'])).trim().slice(0, 8)
  return { hash }
}
