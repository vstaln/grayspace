import * as os from 'os'
import { join } from 'path'
import { MCP_PORT, MCP_SERVER_NAME, mcpUrl } from './config'

export interface McpConfigRecipe {
  id: string
  /** Client name as the user knows it. */
  label: string
  /** One line on what to do with the snippet. */
  hint: string
  /** Where the snippet belongs on this machine, when there is a fixed location. */
  target?: string
  /** Drives syntax highlighting and the copy button's label. */
  language: 'json' | 'toml' | 'shell'
  snippet: string
}

export interface McpConfigBundle {
  serverName: string
  url: string
  port: number
  transport: 'http'
  recipes: McpConfigRecipe[]
}

const home = (): string => os.homedir()

/**
 * Every config shape a user might need to paste, generated against the port the
 * server is actually listening on. Copying one of these is the entire setup
 * step — the server is already running whenever the app is open.
 */
export function mcpConfigBundle(port: number = MCP_PORT): McpConfigBundle {
  const url = mcpUrl(port)
  const name = MCP_SERVER_NAME

  const standardJson = JSON.stringify(
    { mcpServers: { [name]: { type: 'http', url } } },
    null,
    2
  )

  const recipes: McpConfigRecipe[] = [
    {
      id: 'claude-code-cli',
      label: 'Claude Code — команда',
      hint: 'Выполните в терминале один раз; сервер добавится в пользовательскую область.',
      language: 'shell',
      snippet: `claude mcp add --transport http --scope user ${name} ${url}`
    },
    {
      id: 'claude-code-json',
      label: 'Claude Code — файл проекта',
      hint: 'Положите в .mcp.json в корне проекта, чтобы сервер видела вся команда.',
      target: '.mcp.json',
      language: 'json',
      snippet: standardJson
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      hint: 'Настройки → Developer → Edit Config, затем перезапустите приложение.',
      target: claudeDesktopConfigPath(),
      language: 'json',
      snippet: standardJson
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      hint: 'Добавьте секцию в конец config.toml.',
      target: join(home(), '.codex', 'config.toml'),
      language: 'toml',
      snippet: `[mcp_servers.${name}]\nurl = "${url}"`
    },
    {
      id: 'cursor',
      label: 'Cursor',
      hint: 'Settings → MCP → Add new server, или отредактируйте файл напрямую.',
      target: join(home(), '.cursor', 'mcp.json'),
      language: 'json',
      snippet: standardJson
    },
    {
      id: 'vscode',
      label: 'VS Code / Copilot',
      hint: 'VS Code использует ключ "servers" вместо "mcpServers".',
      target: join('.vscode', 'mcp.json'),
      language: 'json',
      snippet: JSON.stringify({ servers: { [name]: { type: 'http', url } } }, null, 2)
    },
    {
      id: 'generic',
      label: 'Любой другой клиент',
      hint: 'Стандартная форма streamable HTTP — подходит для Windsurf, Cline, Zed и прочих.',
      language: 'json',
      snippet: standardJson
    },
    {
      id: 'url',
      label: 'Только адрес',
      hint: 'Если клиент спрашивает лишь URL и тип транспорта (streamable HTTP).',
      language: 'shell',
      snippet: url
    }
  ]

  return { serverName: name, url, port, transport: 'http', recipes }
}

/** Where Claude Desktop keeps its config on each platform. */
function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'darwin') {
    return join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  return join(home(), '.config', 'Claude', 'claude_desktop_config.json')
}
