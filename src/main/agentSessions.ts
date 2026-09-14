import { promises as fsp } from 'fs'
import * as os from 'os'
import { basename, join, resolve } from 'path'
import { readSqliteTable } from './sqliteRead.ts'

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
  agentId: 'claude' | 'codex' | 'antigravity' | 'grok'
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

/**
 * As many as the Code view can hold, so a restore that reopens a full board
 * still has a conversation to offer every terminal.
 */
const DEFAULT_LIMIT = 32
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
/**
 * Grok keeps one folder per session, so a group directory can hold hundreds of
 * them; only the newest are opened, and its `summary.json` is a small index
 * file that never needs more than this.
 */
const GROK_SUMMARY_BYTES = 64 * 1024
/**
 * How many session summaries the group search may open when no directory name
 * matches this folder. It is what keeps a machine with a long Grok history
 * from being walked in full on every refresh.
 */
const GROK_GROUP_PROBE_BUDGET = 40
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

/**
 * `file:///C:/Users/x/project` → `C:/Users/x/project`, the form `samePath`
 * compares. A plain path is left as it is: the column has held both.
 */
export function workspaceUriToPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri
  let path = uri.replace(/^file:\/\/\/?/, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    // A stray percent sign is not worth dropping the whole row over.
  }
  // A UNC share (`file://server/share`) keeps its leading slashes.
  if (uri.startsWith('file://') && !uri.startsWith('file:///')) return `//${path}`
  // A POSIX path lost its root to the prefix strip; a drive letter never had one.
  return /^[A-Za-z]:/.test(path) ? path : `/${path}`
}

/**
 * Antigravity writes `2026-09-14 14:29:24.9264321+00:00` — a space instead of
 * the `T`, and more fractional digits than `Date` accepts.
 */
export function parseSqlTime(value: unknown): number {
  if (typeof value === 'number') return epochMs(value)
  if (typeof value !== 'string') return 0
  const text = value.trim()
  if (!text) return 0
  const normalized = text
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2}:\d{2}|Z)?$/, (zone) => zone || 'Z')
  const at = Date.parse(normalized)
  return Number.isFinite(at) && at > 0 ? at : 0
}

/** One row of `conversation_summaries`, as far as resuming cares. */
export function summaryConversation(row: Record<string, unknown>, dir: string): AgentConversation | null {
  const id = typeof row.conversation_id === 'string' ? row.conversation_id : ''
  if (!SAFE_ID.test(id)) return null
  // A conversation the CLI killed cannot be resumed, and a nested one belongs
  // to its parent's run rather than to the user's terminal.
  if (row.killed === 1 || row.killed === true) return null
  if (typeof row.parent_conversation_id === 'string' && row.parent_conversation_id) return null

  const raw = typeof row.workspace_uris === 'string' ? row.workspace_uris : ''
  let uris: string[] = []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) uris = parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    if (raw) uris = [raw]
  }
  if (!uris.some((uri) => samePath(workspaceUriToPath(uri), dir))) return null

  const updatedAt = Math.max(parseSqlTime(row.last_modified_time), parseSqlTime(row.last_user_input_time))
  const title =
    candidateTitle(typeof row.title === 'string' ? row.title : '')?.text ??
    candidateTitle(typeof row.preview === 'string' ? row.preview : '')?.text ??
    ''
  return { id, agentId: 'antigravity', title, updatedAt, command: `agy --conversation ${id}` }
}

/**
 * Grok names a session group after the working directory, URL-encoded. A path
 * too long to encode gets a slug plus a hash instead, and the real path is
 * recorded in a `.cwd` file beside the sessions — so a name that does not
 * decode to a path is left as it is and simply never matches.
 */
export function decodeGrokCwd(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export interface GrokSummary {
  id: string
  cwd: string
  title: string
  updatedAt: number
}

/**
 * `summary.json` — Grok's own index entry for a session. Every field is
 * optional here: a summary written by a build that names things differently,
 * or one truncated mid-write, must still leave the session resumable from its
 * directory name and file times.
 */
export function parseGrokSummary(text: string): GrokSummary | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const info = isRecord(parsed.info) ? parsed.info : {}
  const pick = (...values: unknown[]): string =>
    values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? ''

  const id = pick(info.session_id, info.sessionId, info.id, parsed.session_id, parsed.sessionId)
  const cwd = pick(info.cwd, info.working_directory, info.workingDirectory, parsed.cwd)
  // The model-written title is what the picker shows; the summaries behind it
  // are longer, but a long line beats no line at all.
  const title =
    candidateTitle(pick(parsed.generated_title, parsed.title))?.text ??
    candidateTitle(pick(parsed.session_summary, parsed.last_turn_summary, parsed.last_recap))?.text ??
    ''
  const updatedAt = Math.max(parseSqlTime(parsed.updated_at), parseSqlTime(parsed.created_at))
  return { id, cwd, title, updatedAt }
}

/**
 * The first thing the user typed, from the ACP update stream. Grok writes a
 * prompt either whole (`user_message`) or in streamed pieces
 * (`user_message_chunk`), so both shapes are read, and a chunked prompt is
 * stitched back together before it is judged.
 */
export function parseGrokTitle(head: string): string {
  const picker = new TitlePicker()
  let chunks = ''
  for (const entry of jsonLines(head)) {
    const kind = typeof entry.sessionUpdate === 'string' ? entry.sessionUpdate : ''
    if (kind !== 'user_message' && kind !== 'user_message_chunk') {
      // Anything after the prompt belongs to the agent; a stitched prompt is
      // complete as soon as the turn moves on.
      if (chunks.trim()) break
      continue
    }
    const content = entry.content
    if (kind === 'user_message_chunk' && isRecord(content) && typeof content.text === 'string') {
      chunks += content.text
      continue
    }
    if (picker.offer(messageCandidate(content))) break
    if (isRecord(content) && typeof content.text === 'string' && picker.offer(candidateTitle(content.text))) break
  }
  if (!picker.value) picker.offer(candidateTitle(chunks))
  return picker.value
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
  const root = join(home, '.gemini', 'antigravity-cli')
  // Two stores, because neither is complete on its own: the summaries database
  // is the only place a conversation's id is tied to its folder, while the
  // prompt history is the only place the user's own words are. A conversation
  // started in a build that stopped stamping ids into the history would be
  // invisible if we read the history alone.
  const [rows, tail] = await Promise.all([
    readSqliteTable(join(root, 'conversation_summaries.db'), 'conversation_summaries', {
      // The trailing `raw_summary` blob is of no interest, and not assembling
      // it keeps a long conversation's row to a single page read.
      maxPayloadBytes: 16 * 1024
    }).catch(() => []),
    readChunk(join(root, 'history.jsonl'), HISTORY_TAIL_BYTES, true).catch(() => '')
  ])

  const byId = new Map<string, AgentConversation>()
  for (const row of rows) {
    const conversation = summaryConversation(row, dir)
    if (conversation) byId.set(conversation.id, conversation)
  }
  for (const conversation of parseAntigravityHistory(tail, dir)) {
    const known = byId.get(conversation.id)
    if (!known) {
      byId.set(conversation.id, conversation)
      continue
    }
    // What the user typed beats the CLI's generated summary, and the history
    // can be newer than a summary that has not been rewritten yet.
    if (conversation.title) known.title = conversation.title
    if (conversation.updatedAt > known.updatedAt) known.updatedAt = conversation.updatedAt
  }
  return Array.from(byId.values())
}

/**
 * Where Grok keeps its sessions. `GROK_HOME` moves the whole store, so it is
 * tried first, and the default home stays a candidate either way: an exported
 * variable that points somewhere empty must not hide the real history.
 */
function grokRoots(home: string): string[] {
  const override = process.env.GROK_HOME?.trim()
  const roots = override ? [join(override, 'sessions')] : []
  roots.push(join(home, '.grok', 'sessions'))
  return roots
}

/** The session group Grok recorded for this folder, or '' when it kept none. */
async function grokGroupDir(root: string, dir: string): Promise<string> {
  const names = await fsp.readdir(root).catch(() => [] as string[])
  for (const name of names) {
    if (samePath(decodeGrokCwd(name), dir)) return join(root, name)
  }
  // A path too long to encode is stored under a slug plus a hash, with the
  // original written to `.cwd`. Only folders no name matched pay this read.
  for (const name of names) {
    const recorded = await fsp.readFile(join(root, name, '.cwd'), 'utf8').catch(() => '')
    if (recorded.trim() && samePath(recorded.trim(), dir)) return join(root, name)
  }
  // Last resort: ask the sessions themselves. A build that names its groups by
  // some other scheme would otherwise have no history here at all, and every
  // session records the folder it ran in. It is a bounded scan, and it only
  // ever runs for a folder Grok has no group for — most often because the user
  // has never run Grok here, where the listing above is already empty.
  let budget = GROK_GROUP_PROBE_BUDGET
  for (const name of names) {
    const group = join(root, name)
    for (const id of await fsp.readdir(group).catch(() => [] as string[])) {
      if (!SAFE_ID.test(id) || budget-- <= 0) continue
      const summary = parseGrokSummary(
        await readChunk(join(group, id, 'summary.json'), GROK_SUMMARY_BYTES, false).catch(() => '')
      )
      if (summary?.cwd && samePath(summary.cwd, dir)) return group
    }
  }
  return ''
}

async function grokConversations(dir: string, home: string, limit: number): Promise<AgentConversation[]> {
  let group = ''
  for (const root of grokRoots(home)) {
    group = await grokGroupDir(root, dir)
    if (group) break
  }
  if (!group) return []

  const ids = (await fsp.readdir(group).catch(() => [] as string[])).filter((name) => SAFE_ID.test(name))
  // `updates.jsonl` is the authoritative log, so a directory without one holds
  // nothing to resume, and its write time is when the session was last used.
  const candidates = await statFiles(ids.map((id) => join(group, id, 'updates.jsonl')), limit)

  const out: AgentConversation[] = []
  for (const candidate of candidates) {
    const sessionDir = join(candidate.path, '..')
    const id = basename(sessionDir)
    const summary = parseGrokSummary(await readChunk(join(sessionDir, 'summary.json'), GROK_SUMMARY_BYTES, false).catch(() => ''))
    // A hashed group name can in principle be shared; the summary's own cwd is
    // the last word on whether the session belongs to this folder.
    if (summary?.cwd && !samePath(summary.cwd, dir)) continue
    const title = summary?.title || parseGrokTitle(await readChunk(candidate.path, HEAD_BYTES, false).catch(() => ''))
    out.push({
      id,
      agentId: 'grok',
      title,
      updatedAt: summary?.updatedAt || candidate.mtime,
      command: `grok --resume ${id}`
    })
  }
  return out
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
    [claudeConversations, codexConversations, antigravityConversations, grokConversations].map((provider) =>
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
  // folder also has conversations in the others — and a restore that reopens
  // three terminals of one agent needs three of its conversations, not one.
  // So the room is dealt out a round at a time, newest first within each
  // agent, and any room an agent does not use goes back to plain recency.
  const queues = new Map<string, AgentConversation[]>()
  for (const conversation of byRecency) {
    const queue = queues.get(conversation.agentId)
    if (queue) queue.push(conversation)
    else queues.set(conversation.agentId, [conversation])
  }
  const picked: AgentConversation[] = []
  while (picked.length < limit) {
    let dealt = false
    for (const queue of queues.values()) {
      if (picked.length >= limit) break
      const next = queue.shift()
      if (!next) continue
      picked.push(next)
      dealt = true
    }
    if (!dealt) break
  }
  return picked.sort((a, b) => b.updatedAt - a.updatedAt)
}
