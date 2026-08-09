import * as fs from 'fs'
import * as net from 'net'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { app } from 'electron'
import { MCP_SERVER_NAME, mcpUrl } from './config'

/**
 * Wires this app's own MCP server into whatever CLI agent the user opens inside
 * its terminals, so `claude`, `codex` or `opencode` sees the workspace's tools
 * (terminals, the second brain, task coordination) without a manual setup step.
 *
 * Scope is deliberately asymmetric:
 *  - Claude Code reads `.mcp.json` from its cwd, so writing one into the
 *    project folder the user opened is scoped to that project — it says nothing
 *    about any other repo on the machine, and Claude still prompts the user to
 *    approve it on first use (this only removes the setup step, not the trust
 *    prompt).
 *  - opencode does the same with its own `opencode.json` in the cwd, so it
 *    gets a project-scoped entry with the same caveat: first connect asks for
 *    permission, later ones don't.
 *  - Codex CLI has no equivalent per-project file; its only config is the
 *    global `~/.codex/config.toml`, so that's the one place to register it,
 *    same as the manual recipe already told the user to do by hand.
 */

interface McpJson {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

/** The server used to register under this name, which Claude Code silently drops. */
const RESERVED_NAME = 'workspace'

/** Where Codex keeps its global config; honors the env override the CLI itself uses. */
function codexConfigFile(): string {
  const home = process.env.CODEX_HOME ? join(process.env.CODEX_HOME) : join(homedir(), '.codex')
  return join(home, 'config.toml')
}

/**
 * True when something accepts TCP connections on the URL's port within the
 * deadline — used to tell a *live* foreign server (another instance running)
 * from a stale entry left behind by a dead one.
 */
function probeUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      resolve(false)
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve(false)
      return
    }
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || 80) })
    const done = (alive: boolean): void => {
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(800, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Writes a config file the way the state store does: temp file in the same
 * directory, flushed, then one atomic rename — a crash mid-write can never
 * truncate the user's config. The previous content is preserved as a single
 * `.bak` sibling so a bad merge can be undone by hand.
 */
function writeConfigAtomic(file: string, content: string, ensureDir: string | null): void {
  if (ensureDir) fs.mkdirSync(ensureDir, { recursive: true })
  const dir = dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (previous !== content) {
    try {
      fs.writeFileSync(`${file}.bak`, previous, 'utf8')
    } catch (err) {
      console.error(`could not back up ${file}`, err)
    }
  }
  const temp = join(dir, `.${Date.now()}-${process.pid}.tmp`)
  fs.writeFileSync(temp, content, 'utf8')
  try {
    fs.renameSync(temp, file)
  } catch (err) {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* the temp file is disposable */
    }
    throw err
  }
}

/**
 * Merges the workspace server into `<dir>/.mcp.json`, preserving every other
 * server entry. Writes only when something actually changed, and never
 * overwrites a file it can't parse — a mid-edit or hand-tweaked config should
 * not be clobbered just because this ran in the background. A foreign entry is
 * only taken over when its server is provably dead (stale port from a past
 * run), so a live second instance is never broken.
 */
export async function syncProjectMcpConfig(dir: string): Promise<void> {
  if (!dir) return
  const file = join(dir, '.mcp.json')
  const entry = { type: 'http', url: mcpUrl() }

  let config: McpJson = {}
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8')) as McpJson
    } catch (err) {
      console.error(`.mcp.json in ${dir} is not valid JSON — leaving it alone`, err)
      return
    }
  }

  const servers = { ...(config.mcpServers || {}) }
  // Drop the old reserved-name entry a previous version of this app wrote —
  // Claude Code never loaded it, so it's dead weight, not a user's own server.
  const hadReserved = RESERVED_NAME in servers
  delete servers[RESERVED_NAME]

  const existing = servers[MCP_SERVER_NAME] as { url?: string; type?: string } | undefined
  // A workspace-app entry that points somewhere else belongs to another
  // instance (or a hand edit) — leave it alone instead of fighting over it.
  if (!hadReserved && existing?.url === entry.url && existing?.type === entry.type) return
  if (existing && existing.url !== entry.url) {
    const alive = existing.url ? await probeUrl(existing.url) : false
    if (alive) {
      console.warn(`${file} already has ${MCP_SERVER_NAME} at ${existing.url} — not overwriting it`)
      return
    }
    console.warn(`${file} has ${MCP_SERVER_NAME} pointing at a dead server (${existing.url}) — taking over`)
  }

  servers[MCP_SERVER_NAME] = entry
  const next = { ...config, mcpServers: servers }
  try {
    writeConfigAtomic(file, JSON.stringify(next, null, 2) + '\n', null)
  } catch (err) {
    console.error(`could not write ${file}`, err)
  }
}

interface OpenCodeConfig {
  $schema?: string
  mcp?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Registers the workspace server in opencode's project config
 * (`<dir>/opencode.json`), the same per-project file opencode reads from its
 * cwd, so a project opened in an app terminal sees the same tools as Claude
 * Code does via `.mcp.json`.
 *
 * Merges only the `mcp` key and preserves every other field. Never writes a
 * file it can't parse — opencode hard-fails on invalid config, and the user's
 * own settings must not be clobbered by a background sync.
 */
export async function syncProjectOpencodeConfig(dir: string): Promise<void> {
  if (!dir) return
  const file = join(dir, 'opencode.json')

  let config: OpenCodeConfig = {}
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8')) as OpenCodeConfig
    } catch (err) {
      console.error(`opencode.json in ${dir} is not valid JSON — leaving it alone`, err)
      return
    }
  }

  const servers = { ...(config.mcp || {}) }
  const existing = servers[MCP_SERVER_NAME] as
    | { type?: string; url?: string; enabled?: boolean }
    | undefined
  if (existing?.type === 'remote' && existing?.url === mcpUrl() && existing?.enabled !== false) {
    return
  }
  if (existing && existing.url !== mcpUrl()) {
    const alive = existing.url ? await probeUrl(existing.url) : false
    if (alive) {
      console.warn(`${file} already has ${MCP_SERVER_NAME} at ${existing.url} — not overwriting it`)
      return
    }
    console.warn(`${file} has ${MCP_SERVER_NAME} pointing at a dead server (${existing.url}) — taking over`)
  }

  servers[MCP_SERVER_NAME] = { type: 'remote', url: mcpUrl(), enabled: true }
  const next: OpenCodeConfig = {
    ...config,
    $schema: config.$schema || 'https://opencode.ai/config.json',
    mcp: servers
  }
  try {
    writeConfigAtomic(file, JSON.stringify(next, null, 2) + '\n', null)
  } catch (err) {
    console.error(`could not write ${file}`, err)
  }
}

/** Cuts a `[table.header]` section (up to the next top-level header) out of TOML text. */
function stripTomlSection(text: string, header: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    if (line.trim() === header) {
      inSection = true
      continue
    }
    if (inSection && /^\[/.test(line.trim())) inSection = false
    if (!inSection) out.push(line)
  }
  return out.join('\n')
}

/**
 * Keeps the workspace server's section in Codex's global config in sync with
 * the URL this app actually serves on. The section is entirely this app's own
 * — name and URL both derive from `config.ts` — so a stale URL from before a
 * port change is rewritten; every other section in the file is left untouched.
 * An entry that points at a *different* URL (a hand edit, or another app
 * instance) is left alone: clobbering it would silently break the user's or
 * the other instance's setup. The file is updated atomically with a `.bak` of
 * the previous content, and the `CODEX_HOME` env override is honored so a
 * second, isolated instance can never rewrite the real user's config.
 */
export async function ensureCodexGlobalConfig(): Promise<void> {
  // An isolated/test instance (--user-data-dir) must never rewrite the real
  // user's global Codex config — DI-005.
  if (app.commandLine.hasSwitch('user-data-dir')) {
    console.warn('custom userData dir — leaving the global Codex config alone')
    return
  }
  const file = codexConfigFile()
  const section = `[mcp_servers.${MCP_SERVER_NAME}]`
  const body = `${section}\nurl = "${mcpUrl()}"\n`
  let current = ''
  if (fs.existsSync(file)) {
    try {
      current = fs.readFileSync(file, 'utf8')
    } catch (err) {
      console.error(`could not read ${file}`, err)
      return
    }
  }

  // The reserved name only ever mattered to Claude Code's `.mcp.json`, but this
  // app registered it under Codex too before the rename — clean up that entry
  // rather than leave two servers pointed at the same URL.
  const reservedSection = `[mcp_servers.${RESERVED_NAME}]`
  let cleaned = current.includes(reservedSection) ? stripTomlSection(current, reservedSection) : current

  if (cleaned.includes(section)) {
    if (cleaned.includes(body)) return // already exactly right, nothing to do
    // A foreign URL in OUR section means another instance (or a hand edit)
    // owns it now. A live owner is respected; a dead one (stale port from a
    // past run) is reclaimed so CLI agents don't point at nothing.
    const foreignUrl = /url\s*=\s*"([^"]+)"/.exec(cleaned.split(`[mcp_servers.${MCP_SERVER_NAME}]`)[1] || '')?.[1]
    if (foreignUrl && foreignUrl !== mcpUrl()) {
      const alive = await probeUrl(foreignUrl)
      if (alive) {
        console.warn(`${file} has ${MCP_SERVER_NAME} at ${foreignUrl} — not overwriting it`)
        return
      }
      console.warn(`${file} has ${MCP_SERVER_NAME} pointing at a dead server (${foreignUrl}) — taking over`)
    }
    cleaned = stripTomlSection(cleaned, section)
  }

  const addition = `${cleaned && !cleaned.endsWith('\n') ? '\n' : ''}\n${body}`
  writeFileIfPossible(file, cleaned + addition)
}

function writeFileIfPossible(file: string, content: string): void {
  try {
    writeConfigAtomic(file, content, join(dirname(codexConfigFile())))
  } catch (err) {
    console.error(`could not write ${file}`, err)
  }
}
