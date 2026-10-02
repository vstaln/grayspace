import * as fs from 'fs'
import { join } from 'path'

const isDev = Boolean(process.env['ELECTRON_RENDERER_URL'] || process.env.NODE_ENV === 'development')
export const APP_TITLE = isDev ? 'GraySpace (Dev)' : 'GraySpace'

function configuredPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback
}

export const CONTROL_PORT = configuredPort(process.env.WORKSPACE_CONTROL_PORT, 20224)
let activeControlPort = 0

export function controlTcpEnabled(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !isPackaged && Boolean(
    env.ELECTRON_RENDERER_URL || env.NODE_ENV === 'development' || env.WORKSPACE_CONTROL_PORT
  )
}

export function getActiveControlPort(): number {
  return activeControlPort
}

export function setActiveControlPort(port: number): void {
  if (Number.isInteger(port) && port >= 0 && port <= 65_535) {
    activeControlPort = port
  }
}



export const OUTPUT_BUFFER_LIMIT = 50_000


export const MAX_TERMINAL_WRITE_BYTES = 64 * 1024


export const BACKGROUND_DIR_NAME = 'backgrounds'

const shellCache = new Map<string, string>()

export function defaultShell(windowsShell: 'cmd' | 'powershell' = 'cmd'): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const cacheKey = [
      windowsShell,
      systemRoot,
      process.env.ComSpec || '',
      process.env.ProgramFiles || '',
      process.env['ProgramFiles(x86)'] || '',
      process.env.LOCALAPPDATA || ''
    ].join('\\0')
    const cached = shellCache.get(cacheKey)
    if (cached) return cached

    if (windowsShell === 'powershell') {
      const candidates = [
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
        join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
        join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell', 'pwsh.exe')
      ]
      for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
          shellCache.set(cacheKey, candidate)
          return candidate
        }
      }
      shellCache.set(cacheKey, 'powershell.exe')
      return 'powershell.exe'
    }
    const cmdCandidate = join(systemRoot, 'System32', 'cmd.exe')
    if (fs.existsSync(cmdCandidate)) {
      shellCache.set(cacheKey, cmdCandidate)
      return cmdCandidate
    }
    if (process.env.ComSpec && fs.existsSync(process.env.ComSpec)) {
      shellCache.set(cacheKey, process.env.ComSpec)
      return process.env.ComSpec
    }
    shellCache.set(cacheKey, 'cmd.exe')
    return 'cmd.exe'
  }
  // POSIX: prefer the user's SHELL, but a GUI launch from Dock/Finder often
  // has SHELL empty. On macOS fall back to zsh (system default) so brew
  // paths and login profiles resolve instead of bare /bin/sh.
  const posixShell = (process.env.SHELL ?? '').trim()
  if (posixShell) return posixShell
  if (process.platform === 'darwin') {
    for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        // ignore stat errors and try the next candidate
      }
    }
  }
  return '/bin/sh'
}
