import { promises as fsp } from 'fs'
import * as os from 'os'
import { join, resolve } from 'path'

/**
 * Conversations the CLI agents keep on disk, so a Code session can be picked
 * up where it left off instead of starting cold after a restart.
 *
 * Every agent stores its own history in its own shape; nothing here writes to
 * those stores, and a store that is missing, unreadable or in a shape we do
 * not recognise yields nothing rather than an error — a broken history must
 * never keep the Code view from opening.
 */

export interface AgentConversation {
  /** The agent's own conversation id — what its resume flag takes. */
  id: string
  /** Matches `CodeAgent.id` in the renderer, so the row can show its icon. */
  agentId: 'claude' | 'codex' | 'antigravity'
  /** First human message of the conversation, or '' when none was found. */
  title: string
  /** Last activity, ms since epoch. */
  updatedAt: number
  /** Exact command that resumes it. */
  command: string
}

export interface ListOptions {
  /** Overridable for tests; defaults to the real home directory. */
  home?: string
  limit?: number
}

const DEFAULT_LIMIT = 20
/** Enough of a transcript to find its first human message. */
const HEAD_BYTES = 192 * 1024
/**
 * Codex opens a rollout with its full instructions, so the folder it belongs
 * to is known early but the first typed prompt can sit well past that. Every
 * candidate pays the small read; only the ones that turn out to belong to this
 * folder pay the large one.
 */
const CODEX_META_BYTES = 48 * 1024
const CODEX_TITLE_BYTES = 384 * 1024
/** Second look for a transcript whose opening is all preamble. */
const DEEP_TITLE_BYTES = 512 * 1024
const HISTORY_TAIL_BYTES = 2 * 1024 * 1024
/**
 * Codex keeps one folder-agnostic pile of rollouts, so its scan reads heads
 * until it has enough conversations for *this* folder. The budget is what
 * stops a machine with thousands of unrelated sessions from being walked in
 * full; the early exit is what keeps the common case cheap.
 */
const CODEX_FILE_BUDGET = 150
const TITLE_MAX = 140

/** Conversation ids land in a shell command, so keep them boring. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/

/**
 * Prompts a CLI injects on the user's behalf. They are real `user` messages in
 * the transcript but say nothing about what the conversation was about.
 */
const MACHINE_TITLE = /^(<|#{1,3}\s|caveat:)/i

/**
 * A typed slash command. Worth showing when it is all a conversation has —
 * "/code-review" says more than "Claude Code session" — but never in place of
 * a sentence the user actually wrote.
 */
const WEAK_TITLE = /^\//

interface TitleCandidate {
  text: string
  weak: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Seconds since 1970 (10 digits) — anything below this is not a timestamp in ms. */
const SECONDS_CEILING = 100_000_000_000

/**
 * A history that records seconds rather than milliseconds would otherwise
 * date every conversation to 1970 and sort it last.
 */
export function epochMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < SECONDS_CEILING ? Math.round(value * 1000) : Math.round(value)
}

function candidateTitle(raw: unknown): TitleCandidate | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text || MACHINE_TITLE.test(text)) return null
  return {
    text: text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text,
    weak: WEAK_TITLE.test(text)
  }
}

/** Keeps the first strong title seen, and the first weak one as a fallback. */
class TitlePicker {
  private strong = ''
  private weak = ''

  offer(candidate: TitleCandidate | null): boolean {
    if (!candidate) return false
    if (candidate.weak) {
      if (!this.weak) this.weak = candidate.text
      return false
    }
    if (!this.strong) this.strong = candidate.text
    return true
  }

  get value(): string {
    return this.strong || this.weak
  }
}

/**
 * Windows paths differ only in case and separator, and a default macOS volume
 * is case-insensitive too — a transcript recorded as `/Users/x/Project` is the
 * same folder as `/Users/x/project`, and treating it as another one would hide
 * the conversation.
 */
export function samePath(a: string, b: string): boolean {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const normalize = (value: string): string => {
    const abs = resolve(value).replace(/[\\/]+$/, '')
    const cased = caseInsensitive ? abs.toLowerCase() : abs
    return process.platform === 'win32' ? cased.replace(/\//g, '\\') : cased
  }
  if (!a || !b) return false
  return normalize(a) === normalize(b)
}

/** Claude Code names a project folder after the path, with every other character replaced. */
export function claudeProjectSlug(dir: string): string {
  // `resolve('')` is the process's own directory, which would quietly scan a
  // folder nobody asked about.
  if (!dir.trim()) return ''
  return resolve(dir).replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * The same rule with letters and digits of any script kept, for a Claude build
 * that does not flatten a non-ASCII path. Trying both is what keeps a folder
 * named in Cyrillic (or any non-Latin script) from silently having no history.
 */
export function claudeProjectSlugUnicode(dir: string): string {
  if (!dir.trim()) return ''
  return resolve(dir).replace(/[\\/]+$/, '').replace(/[^\p{L}\p{N}]/gu, '-')
}

/** Exported for tests; every caller here goes through a provider. */
export async function readChunk(file: string, bytes: number, fromEnd: boolean): Promise<string> {
  const handle = await fsp.open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= 0) return ''
    const length = Math.min(size, bytes)
    const position = fromEnd ? size - length : 0
    const buffer = Buffer.allocUnsafe(length)
    // One read can come up short on a large file. For a tail that would drop
    // the newest lines — exactly the ones worth reading — so keep going until
    // the window is filled or the file ends.
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
      if (bytesRead <= 0) break
      filled += bytesRead
    }
    const text = buffer.subarray(0, filled).toString('utf8')
    // A cut at a byte boundary leaves one unparseable line at the cut end.
    // Dropping it is cheaper than being wrong about what it said.
    if (filled >= size) return text
    return fromEnd ? text.slice(text.indexOf('\n') + 1) : text.slice(0, text.lastIndexOf('\n') + 1)
  } finally {
    await handle.close()
  }
}

/**
 * Lazily, so a parser that finds what it needs in the first few lines never
 * pays to parse the rest of a half-megabyte transcript.
 */
function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) yield parsed
    } catch {
      // Partial or future-shaped lines are skipped, never fatal.
    }
  }
}

/** `{ message: { content } }` is a string in older transcripts and a part list in newer ones. */
function messageCandidate(content: unknown): TitleCandidate | null {
  if (typeof content === 'string') return candidateTitle(content)
  if (!Array.isArray(content)) return null
  const picker = new TitlePicker()
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type !== 'text' && part.type !== 'input_text') continue
    if (picker.offer(candidateTitle(part.text))) break
  }
  return picker.value ? { text: picker.value, weak: WEAK_TITLE.test(picker.value) } : null
}

export function parseClaudeTitle(head: string): string {
  const picker = new TitlePicker()
  for (const entry of jsonLines(head)) {
    if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) continue
    const message = isRecord(entry.message) ? entry.message : null
    if (picker.offer(messageCandidate(message?.content))) break
  }
  return picker.value
}

/**
 * The folder a Claude transcript was recorded in. Two different paths can
 * flatten to the same project folder name (`a-b` and `a_b`, say), so the
 * transcript's own `cwd` is what decides whether it belongs to this folder.
 */
export function parseClaudeCwd(head: string): string {
  for (const entry of jsonLines(head)) {
    if (typeof entry.cwd === 'string' && entry.cwd) return entry.cwd
  }
  return ''
}

export function parseCodexMeta(head: string): { id: string; cwd: string } | null {
  for (const entry of jsonLines(head)) {
    if (entry.type !== 'session_meta') continue
    const payload = isRecord(entry.payload) ? entry.payload : null
    const id = typeof payload?.session_id === 'string' ? payload.session_id : ''
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ''
    if (!SAFE_ID.test(id) || !cwd) return null
    return { id, cwd }
  }
  return null
}

export function parseCodexTitle(head: string): string {
  const picker = new TitlePicker()
  for (const entry of jsonLines(head)) {
    const payload = isRecord(entry.payload) ? entry.payload : null
    if (payload?.type !== 'message' || payload.role !== 'user') continue
    if (picker.offer(messageCandidate(payload.content))) break
  }
  return picker.value
}

export function parseAntigravityHistory(tail: string, dir: string): AgentConversation[] {
  const byId = new Map<string, AgentConversation>()
  // One history file holds every conversation interleaved, so each id keeps
  // its own picker: the first sentence names it, a slash command stands in
  // when that is all there was.
  const pickers = new Map<string, TitlePicker>()
  for (const entry of jsonLines(tail)) {
    const id = typeof entry.conversationId === 'string' ? entry.conversationId : ''
    const workspace = typeof entry.workspace === 'string' ? entry.workspace : ''
    if (!SAFE_ID.test(id) || !samePath(workspace, dir)) continue
    const at = epochMs(entry.timestamp)
    let picker = pickers.get(id)
    if (!picker) {
      picker = new TitlePicker()
      pickers.set(id, picker)
    }
    picker.offer(candidateTitle(entry.display))
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { id, agentId: 'antigravity', title: '', updatedAt: at, command: `agy --conversation ${id}` })
      continue
    }
    // The last prompt of a conversation is what dates it.
    if (at > existing.updatedAt) existing.updatedAt = at
  }
  for (const conversation of byId.values()) {
    conversation.title = pickers.get(conversation.id)?.value ?? ''
  }
  return Array.from(byId.values())
}

interface Candidate {
  path: string
  mtime: number
}

async function statFiles(paths: string[], max: number): Promise<Candidate[]> {
  const stats = await Promise.all(
    paths.map(async (path) => {
      try {
        const stat = await fsp.stat(path)
        return stat.isFile() && stat.size > 0 ? { path, mtime: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
  )
  return (stats.filter(Boolean) as Candidate[]).sort((a, b) => b.mtime - a.mtime).slice(0, max)
}

async function claudeConversations(dir: string, home: string, limit: number): Promise<AgentConversation[]> {
  // Claude's store is already per folder, so only the transcripts that could
  // reach the list are opened at all.
  const projects = join(home, '.claude', 'projects')
  let names: string[] = []
  let root = ''
  for (const slug of new Set([claudeProjectSlug(dir), claudeProjectSlugUnicode(dir)])) {
    // An empty slug would point at the projects directory itself.
    if (!slug) continue
    root = join(projects, slug)
    names = (await fsp.readdir(root).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'))
    if (names.length > 0) break
  }
  const candidates = await statFiles(names.map((n) => join(root, n)), limit)
  const out: AgentConversation[] = []
  for (const candidate of candidates) {
    const id = candidate.path.split(/[\\/]/).pop()!.slice(0, -'.jsonl'.length)
    if (!SAFE_ID.test(id)) continue
    const head = await readChunk(candidate.path, HEAD_BYTES, false).catch(() => '')
    // Same-slug collisions are rare but real, and offering someone else's
    // conversation is worse than showing nothing.
    const recorded = parseClaudeCwd(head)
    if (recorded && !samePath(recorded, dir)) continue
    let title = parseClaudeTitle(head)
    if (!title) {
      // A transcript that resumes a compacted session opens with a long
      // summary; only those pay for the wider look.
      const deeper = await readChunk(candidate.path, DEEP_TITLE_BYTES, false).catch(() => '')
      title = parseClaudeTitle(deeper)
    }
    out.push({
      id,
      agentId: 'claude',
      title,
      updatedAt: candidate.mtime,
      command: `claude --resume ${id}`
    })
  }
  return out
}

async function codexRollouts(root: string): Promise<string[]> {
  // sessions/<year>/<month>/<day>/rollout-*.jsonl, walked newest day first.
  const files: string[] = []
  const listDesc = async (dir: string): Promise<string[]> =>
    (await fsp.readdir(dir).catch(() => [] as string[])).sort((a, b) => b.localeCompare(a))

  for (const year of await listDesc(root)) {
    for (const month of await listDesc(join(root, year))) {
      for (const day of await listDesc(join(root, year, month))) {
        const dayDir = join(root, year, month, day)
        for (const name of await listDesc(dayDir)) {
          if (name.endsWith('.jsonl')) files.push(join(dayDir, name))
        }
        if (files.length >= CODEX_FILE_BUDGET) return files
      }
    }
  }
  return files
}

async function codexConversations(dir: string, home: string, limit: number): Promise<AgentConversation[]> {
  const root = join(home, '.codex', 'sessions')
  const candidates = await statFiles(await codexRollouts(root), CODEX_FILE_BUDGET)
  const out: AgentConversation[] = []
  for (const candidate of candidates) {
    if (out.length >= limit) break
    const head = await readChunk(candidate.path, CODEX_META_BYTES, false).catch(() => '')
    const meta = parseCodexMeta(head)
    if (!meta || !samePath(meta.cwd, dir)) continue
    let title = parseCodexTitle(head)
    if (!title) {
      const deeper = await readChunk(candidate.path, CODEX_TITLE_BYTES, false).catch(() => '')
      title = parseCodexTitle(deeper)
    }
    out.push({
      id: meta.id,
      agentId: 'codex',
      title,
      updatedAt: candidate.mtime,
      command: `codex resume ${meta.id}`
    })
  }
  return out
}

async function antigravityConversations(dir: string, home: string, _limit: number): Promise<AgentConversation[]> {
  const file = join(home, '.gemini', 'antigravity-cli', 'history.jsonl')
  const tail = await readChunk(file, HISTORY_TAIL_BYTES, true).catch(() => '')
  return parseAntigravityHistory(tail, dir)
}

/**
 * Every resumable conversation recorded for `dir`, newest first.
 *
 * One agent's unreadable store does not hide the others': each provider is
 * isolated and contributes nothing when it fails.
 */
export async function listAgentConversations(
  dir: string,
  options: ListOptions = {}
): Promise<AgentConversation[]> {
  if (typeof dir !== 'string' || !dir.trim()) return []
  const home = options.home ?? os.homedir()
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit as number)) : DEFAULT_LIMIT

  const groups = await Promise.all(
    [claudeConversations, codexConversations, antigravityConversations].map((provider) =>
      provider(dir, home, limit).catch(() => [] as AgentConversation[])
    )
  )

  const seen = new Set<string>()
  const byRecency: AgentConversation[] = []
  for (const conversation of groups.flat()) {
    const key = `${conversation.agentId}:${conversation.id}`
    if (seen.has(key)) continue
    seen.add(key)
    byRecency.push(conversation)
  }
  byRecency.sort((a, b) => b.updatedAt - a.updatedAt)

  // Recency alone lets one busy agent fill the whole list, hiding that the
  // folder also has conversations in the others. Every agent that has any gets
  // its newest in first; the rest of the room is plain recency.
  const picked: AgentConversation[] = []
  const takenAgents = new Set<string>()
  for (const conversation of byRecency) {
    if (picked.length >= limit) break
    if (takenAgents.has(conversation.agentId)) continue
    takenAgents.add(conversation.agentId)
    picked.push(conversation)
  }
  for (const conversation of byRecency) {
    if (picked.length >= limit) break
    if (picked.includes(conversation)) continue
    picked.push(conversation)
  }
  return picked.sort((a, b) => b.updatedAt - a.updatedAt)
}
