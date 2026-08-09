
export const APP_TITLE = 'OrcSpace'

/**
 * Name MCP clients see, and the key used in every generated config snippet.
 * Not "workspace" — Claude Code treats that as a reserved server name and
 * silently refuses to load it, which is a wordless failure to debug.
 */
export const MCP_SERVER_NAME = 'workspace-app'

export const CONTROL_PORT = Number(process.env.WORKSPACE_CONTROL_PORT || 47932)
export const MCP_PORT = Number(process.env.WORKSPACE_MCP_PORT || 47940)

/**
 * The endpoint MCP clients attach to; also what the config panel copies.
 * `localhost`, not a literal IP: the MCP server itself binds both loopback
 * addresses (see mcp-server/src/index.ts) precisely so this name always
 * resolves to a listener no matter which address family a client prefers.
 */
export function mcpUrl(port: number = MCP_PORT): string {
  return `http://localhost:${port}/mcp`
}

/** Keeps the per-terminal scrollback that agents can read back over HTTP bounded. */
export const OUTPUT_BUFFER_LIMIT = 50_000

/** A single terminal:write is capped; anything larger is truncated (SEC-010). */
export const MAX_TERMINAL_WRITE_BYTES = 64 * 1024

/** Chat prompts longer than this are refused rather than fed to a CLI agent (SEC-007). */
export const MAX_CHAT_PROMPT_CHARS = 100_000

/** Wallpapers are copied here so the background survives the original being moved. */
export const BACKGROUND_DIR_NAME = 'backgrounds'

export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/sh'
}
