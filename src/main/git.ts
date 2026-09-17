import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitBranch, GitCommit } from '../preload/api.ts'

const run = promisify(execFile)








const GIT_READ_TIMEOUT_MS = 30_000
const GIT_WRITE_TIMEOUT_MS = 120_000

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















const inflightStatus = new Map<string, Promise<GitStatus>>()

export async function readGitStatus(cwd: string | undefined, signal?: AbortSignal): Promise<GitStatus> {
  if (!cwd) return EMPTY()
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  if (!signal) {
    const shared = inflightStatus.get(cwd)
    if (shared) return shared
  }
  const task = readGitStatusInner(cwd, signal).finally(() => {
    if (inflightStatus.get(cwd) === task) inflightStatus.delete(cwd)
  })
  if (!signal) inflightStatus.set(cwd, task)
  return task
}

async function readGitStatusInner(cwd: string, signal?: AbortSignal): Promise<GitStatus> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'], GIT_READ_TIMEOUT_MS, signal)).trim()
    if (!root) return EMPTY()





    const statusArgs = ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal'] as const
    const logArgs = ['log', '-1', '--format=%H%x1f%s%x1f%ct'] as const

    const porcelainPromise = git(cwd, [...statusArgs], GIT_READ_TIMEOUT_MS, signal)
    const logPromise = git(cwd, [...logArgs], GIT_READ_TIMEOUT_MS, signal).catch(() => '')

    const [porcelain, logRaw] = await Promise.all([porcelainPromise, logPromise])




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


        if (code[0] !== ' ' && code[0] !== '?') status.staged += 1
        if (code[1] !== ' ' && code[1] !== '?') status.modified += 1
      }



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

    if (/not a git repository/i.test(raw)) return EMPTY()

    if (/maxBuffer/i.test(raw) || /ENOBUFS/i.test(raw)) {
      return EMPTY({ error: 'git status output too large for buffer (large untracked tree)' })
    }
    if (isTimeoutError(err)) {
      return EMPTY({ error: 'git status timed out — repository may be on a slow mount or locked' })
    }
    return EMPTY({ error: raw.trim().slice(0, 300) })
  }
}


export function parseHeader(header: string): Partial<GitStatus> {
  if (!header) return {}

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


function isDirtyStatus(status: GitStatus): boolean {
  // Untracked files ride along on checkout, so only tracked changes block it.
  return status.modified + status.staged + status.conflicted > 0
}

function assertSafeRef(ref: string): void {
  const value = ref.trim()
  if (!value) throw new Error('a branch or commit is required')
  if (value.length > 256) throw new Error('ref is too long')
  if (value.startsWith('-')) throw new Error('invalid ref')
  if (/[\0\n\r]/.test(value)) throw new Error('invalid ref')
}

export async function listBranches(cwd: string | undefined, signal?: AbortSignal): Promise<{ branches: GitBranch[]; current: string }> {
  if (!cwd) return { branches: [], current: '' }
  const [headsRaw, currentRaw] = await Promise.all([
    git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], GIT_READ_TIMEOUT_MS, signal),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], GIT_READ_TIMEOUT_MS, signal).catch(() => '')
  ])
  const current = currentRaw.trim().replace(/\r/g, '')
  const names = headsRaw.split('\n').map((line) => line.trim().replace(/\r/g, '')).filter(Boolean)
  const branches = names.map((name) => ({ name, current: name === current }))
  branches.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
  return { branches, current }
}

export async function listCommits(
  cwd: string | undefined,
  opts: { limit?: number; query?: string; signal?: AbortSignal } = {}
): Promise<{ commits: GitCommit[]; head: string }> {
  if (!cwd) return { commits: [], head: '' }
  const requested = Math.min(Math.max(Number(opts.limit) || 100, 1), 500)
  const query = (opts.query || '').trim().toLowerCase()
  // --max-count applies before the query filter, so a search must scan deeper.
  const limit = query ? 500 : requested
  const [logRaw, headRaw] = await Promise.all([
    git(cwd, ['log', '--all', `--max-count=${limit}`, '--format=%H%x1f%h%x1f%an%x1f%ct%x1f%D%x1f%s'], GIT_READ_TIMEOUT_MS, opts.signal),
    git(cwd, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS, opts.signal).catch(() => '')
  ])
  const head = headRaw.trim().replace(/\r/g, '')
  const commits: GitCommit[] = []
  for (const line of logRaw.split('\n')) {
    const clean = line.replace(/\r$/, '')
    if (!clean) continue
    const [hash, short, author, at, refsRaw, ...subjectParts] = clean.split('\x1f')
    if (!hash) continue
    const subject = subjectParts.join('\x1f')
    const refs = (refsRaw || '').split(',').map((r) => r.trim()).filter(Boolean)
    if (query && !`${subject} ${hash} ${short} ${author}`.toLowerCase().includes(query)) continue
    commits.push({ hash, short, subject, author, at: Number(at) * 1000, refs })
  }
  return { commits, head }
}

export async function checkoutRef(cwd: string, ref: string, signal?: AbortSignal): Promise<{ branch: string; hash: string }> {
  assertSafeRef(ref)
  const status = await readGitStatus(cwd, signal)
  if (!status.repo) throw new Error('not a git repository')
  if (isDirtyStatus(status)) {
    throw Object.assign(new Error('uncommitted tracked changes — commit or discard them before switching'), { code: 'dirty' })
  }
  await git(cwd, ['checkout', ref.trim()], GIT_WRITE_TIMEOUT_MS, signal)
  const [branchRaw, hashRaw] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], GIT_READ_TIMEOUT_MS, signal).catch(() => ''),
    git(cwd, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS, signal).catch(() => '')
  ])
  return { branch: branchRaw.trim().replace(/\r/g, ''), hash: hashRaw.trim().replace(/\r/g, '').slice(0, 8) }
}

export async function createBranch(cwd: string, name: string, startPoint?: string, signal?: AbortSignal): Promise<{ branch: string; hash: string }> {
  const branchName = name.trim()
  if (!branchName) throw new Error('a branch name is required')
  if (branchName.length > 256) throw new Error('branch name is too long')
  try {
    await git(cwd, ['check-ref-format', '--branch', branchName], GIT_READ_TIMEOUT_MS, signal)
  } catch {
    throw new Error('invalid branch name')
  }
  if (startPoint?.trim()) assertSafeRef(startPoint)
  const status = await readGitStatus(cwd, signal)
  if (!status.repo) throw new Error('not a git repository')
  if (isDirtyStatus(status)) {
    throw Object.assign(new Error('uncommitted tracked changes — commit or discard them before switching'), { code: 'dirty' })
  }
  const args = startPoint?.trim() ? ['checkout', '-b', branchName, startPoint.trim()] : ['checkout', '-b', branchName]
  await git(cwd, args, GIT_WRITE_TIMEOUT_MS, signal)
  const hashRaw = await git(cwd, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS, signal).catch(() => '')
  return { branch: branchName, hash: hashRaw.trim().replace(/\r/g, '').slice(0, 8) }
}

export async function commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<{ hash: string }> {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  await git(cwd, ['add', '-A'], GIT_WRITE_TIMEOUT_MS, signal)
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  await git(cwd, ['commit', '-m', message], GIT_WRITE_TIMEOUT_MS, signal)
  const hash = (await git(cwd, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS, signal)).trim().slice(0, 8)
  return { hash }
}









export interface GitDiffStat {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  status: string
}

export interface GitDiffResult {
  stat: GitDiffStat[]
  truncated: boolean
  error?: string
}





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
      if (!fileClean) {
        if (parts[i + 1] && parts[i + 2]) {
          const oldPath = parts[i + 1].replace(/\r$/, '')
          const newPath = parts[i + 2].replace(/\r$/, '')
          i += 2
          stat.push({
            path: newPath,
            oldPath,
            additions: add === '-' ? 0 : Number(add) || 0,
            deletions: del === '-' ? 0 : Number(del) || 0,
            status: 'R'
          })
          if (stat.length >= 2000) return { stat, truncated: true }
        }
        continue
      }
      stat.push({
        path: fileClean,
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
