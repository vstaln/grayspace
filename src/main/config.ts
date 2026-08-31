
export const APP_TITLE = 'OrcSpace'

/**
 * Name MCP clients see, and the key used in every generated config snippet.
 * Not "workspace" — Claude Code treats that as a reserved server name and
 * silently refuses to load it, which is a wordless failure to debug.
 */

function configuredPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback
}

export const CONTROL_PORT = configuredPort(process.env.WORKSPACE_CONTROL_PORT, 20220)

/** Keeps the per-terminal scrollback that agents can read back over HTTP bounded. */
export const OUTPUT_BUFFER_LIMIT = 50_000

/** A single terminal:write is capped; anything larger is truncated (SEC-010). */
export const MAX_TERMINAL_WRITE_BYTES = 64 * 1024

/** Chat prompts longer than this are refused rather than fed to a CLI agent (SEC-007). */
export const MAX_CHAT_PROMPT_CHARS = 100_000

/** Wallpapers are copied here so the background survives the original being moved. */
export const BACKGROUND_DIR_NAME = 'backgrounds'

export function defaultShell(windowsShell: 'cmd' | 'powershell' = 'cmd'): string {
  if (process.platform === 'win32') {
    return windowsShell === 'powershell' ? 'powershell.exe' : process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/sh'
}
