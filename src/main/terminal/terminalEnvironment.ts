import { orcTerminalEnv } from '../orcCli.ts'

export function terminalBaseEnv(env: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (upper === 'PATH' || upper === 'NO_COLOR' || upper === 'FORCE_COLOR' || upper === 'TERM' || upper === 'COLORTERM' || upper === 'COLORFGBG') continue
    copy[key] = value
  }
  return copy
}

export function codeTerminalColorEnv(id: string): Record<string, string> {
  if (!id.startsWith('code-')) return {}
  return { CLICOLOR: '1', CLICOLOR_FORCE: '1', ANSICON: '1', ConEmuANSI: 'ON' }
}

export function windowsShellArgs(windowsShell: 'cmd' | 'powershell'): string[] {
  if (process.platform !== 'win32') return []
  return windowsShell === 'powershell' ? ['-NoLogo', '-NoExit', '-Command', 'chcp 65001 > $null'] : ['/K', 'chcp 65001 >nul']
}

export function safeOrcTerminalEnv(id: string): Record<string, string> {
  try {
    return orcTerminalEnv(id)
  } catch {
    const path = process.env.PATH ?? process.env.Path ?? ''
    return { ...(path ? { PATH: path } : {}), ORCSPACE_AGENT_ID: id, ORCSPACE_NODE: process.execPath }
  }
}

export function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}
