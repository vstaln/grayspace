import { execFile } from 'child_process'
import { promisify } from 'util'

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







export async function readGitDiff(
  cwd: string,
  filePath: string,
  opts: { staged?: boolean; maxBytes?: number; signal?: AbortSignal } = {}
): Promise<{ diff: string; truncated: boolean; error?: string }> {
  if (!cwd || !filePath) return { diff: '', truncated: false, error: 'missing path' }
  if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
  const maxBytes = opts.maxBytes ?? 512 * 1024
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
