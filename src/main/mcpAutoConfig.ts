import * as fs from 'fs'
import * as net from 'net'
import { randomBytes } from 'crypto'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { MCP_SERVER_NAME, mcpUrl } from './config.ts'
import { isLoopbackUrl } from './netGuard.ts'
import { mcpAuthHeaders } from './controlToken.ts'

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

interface JsonServerConfig {
  url?: string
  serverUrl?: string
  type?: string
  disabled?: boolean
}

/** The server used to register under this name, which Claude Code silently drops. */
const RESERVED_NAME = 'workspace'
const LEGACY_NAMES = ['workspace-app', 'my-workspace'] as const

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
export function probeUrl(url: string): Promise<boolean> {
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
    // The URL comes from a user-controlled config file. Only another local
    // OrcSpace instance needs probing; arbitrary remote probes are an SSRF.
    if (!isLoopbackUrl(parsed.origin)) {
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
export function writeConfigAtomic(file: string, content: string, ensureDir: string | null): void {
  if (ensureDir) fs.mkdirSync(ensureDir, { recursive: true })
  const dir = dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  // Preserve the original file's mode (P8): these configs can carry secrets
  // (the MCP token), and an atomic rename would otherwise drop a user's
  // carefully-set 0600 down to the umask default (typically 0644).
  let mode: number | undefined
  try {
    mode = fs.statSync(file).mode
  } catch {
    /* new file — keep the umask default */
  }
  if (previous !== content) {
    try {
      fs.writeFileSync(`${file}.bak`, previous, 'utf8')
      if (mode !== undefined) fs.chmodSync(`${file}.bak`, mode)
    } catch (err) {
      console.error(`could not back up ${file}`, err)
    }
  }
  // Syncs can overlap when a workspace is selected while startup config work is
  // still in flight. A timestamp/PID name can collide in that case and one
  // writer may rename or delete the other writer's temporary file.
  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  fs.writeFileSync(temp, content, 'utf8')
  if (mode !== undefined) fs.chmodSync(temp, mode)
  else fs.chmodSync(temp, 0o600)
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
  // Headers matter here: without them the CLI agent cannot authenticate to the
  // token-gated MCP endpoint and the entry would be dead weight (P1).
  const entry = { type: 'http', url: mcpUrl(), headers: mcpAuthHeaders() }

  let config: McpJson = {}
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as McpJson
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
  for (const legacy of LEGACY_NAMES) delete servers[legacy]

  const existing = servers[MCP_SERVER_NAME] as { url?: string; type?: string; headers?: unknown } | undefined
  // A workspace-app entry that points somewhere else belongs to another
  // instance (or a hand edit) — leave it alone instead of fighting over it.
  // Headers are compared too: an entry this app wrote before the token gate
  // must be refreshed with the auth headers, not skipped as "already right".
  if (!hadReserved && existing && existing.url === entry.url && existing.type === entry.type && JSON.stringify(existing.headers) === JSON.stringify(entry.headers)) return
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
      config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as OpenCodeConfig
    } catch (err) {
      console.error(`opencode.json in ${dir} is not valid JSON — leaving it alone`, err)
      return
    }
  }

  const servers = { ...(config.mcp || {}) }
  for (const legacy of LEGACY_NAMES) delete servers[legacy]
  const existing = servers[MCP_SERVER_NAME] as
    | { type?: string; url?: string; enabled?: boolean; headers?: unknown }
    | undefined
  if (existing?.type === 'remote' && existing?.url === mcpUrl() && existing?.enabled !== false && JSON.stringify(existing.headers) === JSON.stringify(mcpAuthHeaders())) {
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

  servers[MCP_SERVER_NAME] = { type: 'remote', url: mcpUrl(), enabled: true, headers: mcpAuthHeaders() }
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

/**
 * Shared JSON merger for clients whose config is a top-level `mcpServers`
 * object. The caller supplies the documented transport key because Cursor,
 * Windsurf, and Cline use different names for a remote URL.
 */
async function syncJsonMcpConfig(
  file: string,
  urlKey: 'url' | 'serverUrl',
  entry: JsonServerConfig,
  label: string
): Promise<void> {
  // Every HTTP client entry must carry the token headers or the CLI agent
  // would connect to a server that now refuses unauthenticated requests (P1).
  const authedEntry: JsonServerConfig & { headers?: Record<string, string> } = { ...entry, headers: mcpAuthHeaders() }
  let config: McpJson = {}
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root is not an object')
      config = parsed as McpJson
      if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
        throw new Error('mcpServers is not an object')
      }
    } catch (err) {
      console.error(`${label} is not valid JSON — leaving it alone`, err)
      return
    }
  }

  const servers = { ...(config.mcpServers || {}) }
  for (const legacy of [...LEGACY_NAMES, RESERVED_NAME]) delete servers[legacy]
  const existing = servers[MCP_SERVER_NAME] as JsonServerConfig | undefined
  const existingUrl = existing?.[urlKey] || existing?.url || existing?.serverUrl
  const targetUrl = authedEntry[urlKey] || authedEntry.url || authedEntry.serverUrl
  if (existing && existingUrl === targetUrl && !existing.disabled) {
    // Removing a legacy entry is still a meaningful cleanup, so only return
    // when the rest of the managed section is already exactly right.
    if (JSON.stringify(existing) === JSON.stringify(authedEntry) && Object.keys(servers).length === Object.keys(config.mcpServers || {}).length) return
  }
  if (existing && existingUrl && existingUrl !== targetUrl) {
    const alive = await probeUrl(existingUrl)
    if (alive) {
      console.warn(`${file} already has ${MCP_SERVER_NAME} at ${existingUrl} — not overwriting it`)
      return
    }
    console.warn(`${file} has ${MCP_SERVER_NAME} pointing at a dead server (${existingUrl}) — taking over`)
  }

  servers[MCP_SERVER_NAME] = authedEntry
  const next = { ...config, mcpServers: servers }
  if (JSON.stringify(next) === JSON.stringify(config)) return
  try {
    writeConfigAtomic(file, JSON.stringify(next, null, 2) + '\n', null)
  } catch (err) {
    console.error(`could not write ${file}`, err)
  }
}

/** Cursor's project MCP file is `.cursor/mcp.json` and uses `url` for HTTP. */
export function syncProjectCursorConfig(dir: string): Promise<void> {
  if (!dir) return Promise.resolve()
  return syncJsonMcpConfig(join(dir, '.cursor', 'mcp.json'), 'url', { url: mcpUrl(), type: 'streamableHttp' }, `${dir}/.cursor/mcp.json`)
}

/**
 * Registers OrcSpace in Google Antigravity / Gemini CLI project configuration.
 * Antigravity discovers MCP configs hierarchically in `.gemini/config/mcp_config.json`,
 * `.gemini/mcp_config.json`, and `.agents/mcp_config.json`.
 */
export async function syncProjectAntigravityConfig(dir: string): Promise<void> {
  if (!dir) return
  const files = [
    join(dir, '.gemini', 'config', 'mcp_config.json'),
    join(dir, '.gemini', 'mcp_config.json'),
    join(dir, '.agents', 'mcp_config.json')
  ]
  for (const file of files) {
    await syncJsonMcpConfig(file, 'serverUrl', { serverUrl: mcpUrl(), url: mcpUrl() }, file)
  }
}

/**
 * Registers OrcSpace in Google Antigravity global configuration (~/.gemini/config/mcp_config.json).
 */
export async function syncGlobalAntigravityConfig(): Promise<void> {
  const files = [
    join(homedir(), '.gemini', 'config', 'mcp_config.json'),
    join(homedir(), '.gemini', 'mcp_config.json'),
    join(homedir(), '.antigravity', 'mcp_config.json')
  ]
  for (const file of files) {
    await syncJsonMcpConfig(file, 'serverUrl', { serverUrl: mcpUrl(), url: mcpUrl() }, file)
  }
}

/** Windsurf/Cascade reads one global file and documents `serverUrl` for HTTP. */
export function syncGlobalWindsurfConfig(): Promise<void> {
  const file = join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')
  return syncJsonMcpConfig(file, 'serverUrl', { serverUrl: mcpUrl() }, file)
}

/** Kimi Code uses the same HTTP MCP shape. Keep both project and global config
 * in sync so a newly installed client sees OrcSpace immediately. */
export async function syncKimiConfig(dir?: string): Promise<void> {
  const files = [
    ...(dir ? [join(dir, '.kimi', 'mcp.json')] : []),
    join(homedir(), '.kimi', 'mcp.json'),
    join(homedir(), '.config', 'kimi', 'mcp.json')
  ]
  for (const file of files) {
    await syncJsonMcpConfig(file, 'url', { url: mcpUrl(), type: 'streamableHttp' }, file)
  }
}

/**
 * Cline's VS Code extension stores this JSON below VS Code's globalStorage.
 * Only installed Cline extensions are touched; OrcSpace does not create a
 * phantom extension directory on machines that do not have Cline installed.
 */
export async function syncClineConfig(): Promise<void> {
  const roots = process.platform === 'win32'
    ? [
        join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage'),
        join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Code - Insiders', 'User', 'globalStorage')
      ]
    : process.platform === 'darwin'
      ? [
          join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
          join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage')
        ]
      : [
          join(homedir(), '.config', 'Code', 'User', 'globalStorage'),
          join(homedir(), '.config', 'Code - Insiders', 'User', 'globalStorage')
        ]
  const extensionIds = ['saoudrizwan.claude-dev']
  for (const root of roots) {
    for (const extensionId of extensionIds) {
      const extensionRoot = join(root, extensionId)
      if (!fs.existsSync(extensionRoot)) continue
      const file = join(extensionRoot, 'settings', 'cline_mcp_settings.json')
      await syncJsonMcpConfig(file, 'url', { url: mcpUrl(), type: 'streamableHttp', disabled: false }, file)
    }
  }
}

/** Cuts a `[table.header]` section (up to the next top-level header) out of TOML text. */
export function stripTomlSection(text: string, header: string): string {
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
  if (process.env.ORCSPACE_TEST_USER_DATA || process.argv.includes('--user-data-dir')) {
    console.warn('custom userData dir — leaving the global Codex config alone')
    return
  }
  const file = codexConfigFile()
  const section = `[mcp_servers.${MCP_SERVER_NAME}]`
  // Codex's streamable-HTTP schema takes static headers as `http_headers`;
  // without them the CLI could not authenticate to the token-gated endpoint (P1).
  const headerLine = Object.entries(mcpAuthHeaders()).map(([key, value]) => `"${key}" = "${value}"`).join(', ')
  const body = `${section}\nurl = "${mcpUrl()}"\nhttp_headers = { ${headerLine} }\n`
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
  for (const legacy of LEGACY_NAMES) {
    const legacySection = `[mcp_servers.${legacy}]`
    if (cleaned.includes(legacySection)) cleaned = stripTomlSection(cleaned, legacySection)
  }

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

/**
 * Registers OrcSpace in Grok Build's project-scoped config. Grok uses TOML and
 * reads `.grok/config.toml` from the current repository. Only the OrcSpace MCP
 * section is managed; model, UI, permissions, and any user MCP entries remain
 * untouched. A live foreign URL in our section is left alone (same rule as
 * Claude/opencode), so a second instance does not steal the entry.
 */
export async function syncProjectGrokConfig(dir: string): Promise<void> {
  if (!dir) return
  const file = join(dir, '.grok', 'config.toml')
  let current = ''
  if (fs.existsSync(file)) {
    try {
      current = fs.readFileSync(file, 'utf8')
    } catch (err) {
      console.error(`could not read ${file}`, err)
      return
    }
  }
  let cleaned = current
  for (const legacy of [...LEGACY_NAMES, RESERVED_NAME]) {
    const section = `[mcp_servers.${legacy}]`
    if (cleaned.includes(section)) cleaned = stripTomlSection(cleaned, section)
  }
  const section = `[mcp_servers.${MCP_SERVER_NAME}]`
  const headerLine = Object.entries(mcpAuthHeaders()).map(([key, value]) => `"${key}" = "${value}"`).join(', ')
  const body = `${section}\nurl = "${mcpUrl()}"\nhttp_headers = { ${headerLine} }\nenabled = true\n`
  if (cleaned.includes(section)) {
    if (cleaned.includes(body)) return
    const foreignUrl = /url\s*=\s*"([^"]+)"/.exec(cleaned.split(section)[1] || '')?.[1]
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
  const next = `${cleaned.trimEnd()}${cleaned.trim() ? '\n\n' : ''}${body}`
  if (next !== current) writeConfigAtomic(file, next, dirname(file))
}

function writeFileIfPossible(file: string, content: string): void {
  try {
    writeConfigAtomic(file, content, join(dirname(codexConfigFile())))
  } catch (err) {
    console.error(`could not write ${file}`, err)
  }
}
