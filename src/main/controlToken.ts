import { randomBytes } from 'crypto'
import * as fs from 'fs'
import { join } from 'path'
import { getUserDataDir } from './userData.ts'

/** Header every control-server request must carry. */
export const CONTROL_TOKEN_HEADER = 'x-orcspace-token'

let cached: string | null = null

/**
 * Shared secret between the app and the local tools it trusts.
 *
 * The control server can open shells and type into them, so "it came from
 * loopback" was never authorisation — every process on the machine is on
 * loopback. The token is generated once per installation, stored in the user's
 * profile with owner-only permissions, and handed to the bundled MCP server
 * through its environment so the normal path needs no configuration.
 *
 * It is deliberately not regenerated per launch: an external agent configured
 * against a previous run would otherwise break on every restart, and the
 * failure ("401 from a server that is clearly up") is a miserable one to debug.
 */
export function controlToken(): string {
  if (cached) return cached
  const file = tokenFile()
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) {
      cached = existing
      return cached
    }
  } catch {
    /* first run, or an unreadable file we are about to replace */
  }
  const token = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(join(getUserDataDir()), { recursive: true })
    // 0o600: on POSIX this keeps other users out. Windows ignores the mode —
    // the profile directory's own ACL is what protects it there.
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    console.error('failed to persist the control token', err)
  }
  cached = token
  return token
}

export function tokenFile(): string {
  return join(getUserDataDir(), 'control-token')
}

/**
 * The headers every generated MCP client config must carry. The MCP endpoint
 * is gated by the same token as the control API (P1), so `.mcp.json`,
 * `opencode.json`, codex `config.toml` and the copy-paste recipes all embed
 * these so CLI agents can authenticate without a manual step.
 */
export function mcpAuthHeaders(): Record<string, string> {
  return { [CONTROL_TOKEN_HEADER]: controlToken() }
}
