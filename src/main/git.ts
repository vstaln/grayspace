import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)

/**
 * A git child must always finish: a frozen `.git/index.lock`, a stuck hook, or
 * a network mount that stops answering would otherwise hang the promise — and
 * with it the single-flight bus (readGitStatus / commitAll run inside bus
 * commands) — forever. Reads get a shorter leash than the commit path, which
 * can legitimately grind through a huge working tree.
 */
const GIT_READ_TIMEOUT_MS = 30_000
const GIT_WRITE_TIMEOUT_MS = 120_000
/** Large monorepos can emit several megabytes of porcelain (e.g. 50k untracked paths). */
const GIT_MAX_BUFFER_BYTES = 12 * 1024 * 1024

async function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_READ_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    const err = new Error('aborted')
    ;(err as NodeJS.ErrnoException).code = 'ABORT_ERR'
    throw err
  }
  // The git binary directly, never a shell: no quoting rules to get wrong on a
  // path with spaces, and nothing in a branch name can be interpreted.
  const { stdout } = await run('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    signal,
    encoding: 'utf8'
  } as Parameters<typeof run>[2] & { signal?: AbortSignal; encoding: BufferEncoding })
  return stdout as string
}

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

function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string }
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || /aborted/i.test(String(e?.message ?? ''))
}

function isTimeoutError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '')
  return /timed out/i.test(msg) || (err as { killed?: boolean })?.killed === true
}

/**
 * Repository status for the project folder.
 *
 * Read by running git, not by parsing what a terminal happens to have printed:
 * a PTY's scrollback is a rendering of a human-facing command, wrapped, paged
 * and coloured, and treating it as an API breaks the first time the user runs
 * something else in that shell.
 */
export async function readGitStatus(cwd: string | undefined, signal?: AbortSignal): Promise<GitStatus> {
  if (!cwd) return EMPTY()
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'], GIT_READ_TIMEOUT_MS, signal)).trim()
    if (!root) return EMPTY()

    // -b gives the branch header; -z avoids quoting surprises in filenames
    // (spaces, newlines, quotes would otherwise be escaped and need unquoting).
    // Parallelize status + log: the log does not depend on status, and on a
    // large repo each `git` spawn costs ~30-80ms; overlapping saves one spawn.
    const statusArgs = ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal'] as const
    const logArgs = ['log', '-1', '--format=%H%x1f%s%x1f%ct'] as const

    const porcelainPromise = git(cwd, [...statusArgs], GIT_READ_TIMEOUT_MS, signal)
    const logPromise = git(cwd, [...logArgs], GIT_READ_TIMEOUT_MS, signal).catch(() => '')

    const [porcelain, logRaw] = await Promise.all([porcelainPromise, logPromise])

    // Normalise line endings: git outputs LF even on Windows, but a CRLF
    // workspace or a future `core.autocrlf` interaction must not leave a stray
    // `\r` in the header/entries (PERF-line-ending).
    const normalized = porcelain.replace(/\r\0/g, '\0').replace(/\r\n/g, '\n')
    const entries = normalized.split('\0').filter(Boolean)
    const header = entries[0]?.startsWith('##') ? entries[0].replace(/\r$/, '') : ''
    const status = EMPTY({ repo: true, root: root.replace(/\r$/, ''), ...parseHeader(header) })

    const statusEntries = entries.slice(header ? 1 : 0)
    for (let i = 0; i < statusEntries.length; i += 1) {
      const entry = statusEntries[i].replace(/\r$/, '')
      if (entry.length < 2) continue
      const code = entry.slice(0, 2)
      if (code === '??') status.untracked += 1
      else if (code.includes('U') || code === 'AA' || code === 'DD') status.conflicted += 1
      else {
        // `?` cannot appear outside `??` with `--untracked-files=normal`,
        // kept as guard for future `--untracked-files=all` or ignored `!!`.
        if (code[0] !== ' ' && code[0] !== '?') status.staged += 1
        if (code[1] !== ' ' && code[1] !== '?') status.modified += 1
      }
      // Porcelain -z emits the old path as a second NUL-delimited item for
      // renames/copies. It belongs to the same change and must not be counted
      // as a separate modified file.
      if (code[0] === 'R' || code[0] === 'C') i += 1
    }

    const log = logRaw.trim().replace(/\r/g, '')
    if (log) {
      const [hash, subject, at] = log.split('\x1f')
      if (hash && subject !== undefined && at) {
        status.lastCommit = { hash: hash.slice(0, 8), subject: subject.replace(/\r/g, ''), at: Number(at) * 1000 }
      }
    }
    return status
  } catch (err) {
    if (isAbortError(err)) throw err
    const raw = String((err as { stderr?: string }).stderr || (err as Error).message)
    // "not a git repository" is an ordinary answer, not a failure to report.
    if (/not a git repository/i.test(raw)) return EMPTY()
    // maxBuffer exceeded: tell the caller it was a size limit, not a corrupt repo.
    if (/maxBuffer/i.test(raw) || /ENOBUFS/i.test(raw)) {
      return EMPTY({ error: 'git status output too large for buffer (large untracked tree)' })
    }
    if (isTimeoutError(err)) {
      return EMPTY({ error: 'git status timed out — repository may be on a slow mount or locked' })
    }
    return EMPTY({ error: raw.trim().slice(0, 300) })
  }
}

/** `## main...origin/main [ahead 2, behind 1]` */
export function parseHeader(header: string): Partial<GitStatus> {
  if (!header) return {}
  // Strip stray CR from Windows line endings before parsing.
  const cleaned = header.replace(/\r/g, '')
  const body = cleaned.slice(2).trim()
  const [branches, tracking] = body.split(/\s+\[/)
  const [branch, upstream] = branches.split('...')
  const ahead = tracking?.match(/ahead (\d+)/)
  const behind = tracking?.match(/behind (\d+)/)
  return {
    branch: branch?.replace(/^No commits yet on /, ''),
    upstream: upstream || undefined,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0
  }
}

/** Stages everything and commits. Callers must hold `git:repo` first. */
export async function commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<{ hash: string }> {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  await git(cwd, ['add', '-A'], GIT_WRITE_TIMEOUT_MS, signal)
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  await git(cwd, ['commit', '-m', message], GIT_WRITE_TIMEOUT_MS, signal)
  const hash = (await git(cwd, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS, signal)).trim().slice(0, 8)
  return { hash }
}

// ---- large-repo diff helpers ------------------------------------------------
// The spec mentions DiffViewer/CommitGraph that do not exist yet as widgets.
// These helpers are the fast path those future viewers should call: first get
// a cheap `--numstat` (no hunks) to render the file list, then fetch a single
// file's hunk on demand with a size cap. Fetching `git diff` for a 2 GB
// working tree at once would otherwise re-create the maxBuffer problem that
// `readGitStatus` just fixed.

export interface GitDiffStat {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  status: string // e.g. 'M', 'A', 'R', 'D', 'U'
}

export interface GitDiffResult {
  stat: GitDiffStat[]
  truncated: boolean
  error?: string
}

/**
 * Cheap summary for a large working tree: one line per changed path, no hunks.
 * Uses `-z` so renames/copies with spaces are split unambiguously.
 */
export async function readGitDiffStat(cwd: string, staged = false, signal?: AbortSignal): Promise<GitDiffResult> {
  if (!cwd) return { stat: [], truncated: false, error: 'no cwd' }
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  try {
    const args = ['diff', '--numstat', '-z', ...(staged ? ['--cached'] : [])]
    const out = await git(cwd, args, GIT_READ_TIMEOUT_MS, signal)
    const parts = out.split('\0').filter(Boolean)
    const stat: GitDiffStat[] = []
    for (let i = 0; i < parts.length; i += 1) {
      const meta = parts[i]
      if (!meta.includes('\t')) {
        continue
      }
      const [add, del, file] = meta.split('\t')
      const fileClean = file?.replace(/\r$/, '')
      if (!fileClean) continue
      let oldPath: string | undefined
      if (parts[i + 1] && !parts[i + 1].includes('\t')) {
        oldPath = parts[i + 1].replace(/\r$/, '')
        if (oldPath && fileClean !== oldPath) {
          oldPath = undefined
        } else {
          oldPath = undefined
        }
      }
      stat.push({
        path: fileClean,
        oldPath,
        additions: add === '-' ? 0 : Number(add) || 0,
        deletions: del === '-' ? 0 : Number(del) || 0,
        status: 'M'
      })
      if (stat.length >= 2000) {
        return { stat, truncated: true }
      }
    }
    return { stat, truncated: false }
  } catch (err) {
    if (isAbortError(err)) throw err
    const msg = String((err as { stderr?: string }).stderr || (err as Error).message)
    if (/not a git repository/i.test(msg)) return { stat: [], truncated: false }
    return { stat: [], truncated: false, error: msg.trim().slice(0, 300) }
  }
}

/**
 * Per-file unified diff, capped so a single 50 MB generated file does not
 * freeze the renderer. Normalises CRLF→LF before returning so the viewer
 * does not show a phantom "`^M`" on every line when `core.autocrlf` is on
 * (line-ending diffing).
 */
export async function readGitDiff(
  cwd: string,
  filePath: string,
  opts: { staged?: boolean; maxBytes?: number; signal?: AbortSignal } = {}
): Promise<{ diff: string; truncated: boolean; error?: string }> {
  if (!cwd || !filePath) return { diff: '', truncated: false, error: 'missing path' }
  if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  const maxBytes = opts.maxBytes ?? 512 * 1024 // 512 KB per file is enough for the viewport
  try {
    const args = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      '--ignore-cr-at-eol',
      ...(opts.staged ? ['--cached'] : []),
      '--',
      filePath
    ]
    const raw = await git(cwd, args, GIT_READ_TIMEOUT_MS, opts.signal)
    const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (normalized.length > maxBytes) {
      return { diff: normalized.slice(0, maxBytes), truncated: true }
    }
    return { diff: normalized, truncated: false }
  } catch (err) {
    if (isAbortError(err)) throw err
    const msg = String((err as { stderr?: string }).stderr || (err as Error).message)
    return { diff: '', truncated: false, error: msg.trim().slice(0, 300) }
  }
}
