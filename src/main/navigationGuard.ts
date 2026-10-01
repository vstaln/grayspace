import { isLoopbackHost } from './netGuard.ts'

export function isTrustedAppNavigation(
  url: string,
  options: { devUrl?: string; controlOrigin: string; rendererFile: string }
): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'orc:') return parsed.hostname === 'app'
    if (parsed.protocol === 'file:') {
      if (parsed.host) return false
      const normalizeFilePath = (value: string): string => {
        const path = value.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1')
        return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
      }
      return normalizeFilePath(decodeURIComponent(parsed.pathname)) === normalizeFilePath(options.rendererFile)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

    const allowedOrigins = new Set([new URL(options.controlOrigin).origin])
    if (options.devUrl) {
      allowedOrigins.add(new URL(options.devUrl).origin)
      allowedOrigins.add('http://localhost:20222')
      allowedOrigins.add('http://127.0.0.1:20222')
    }
    return allowedOrigins.has(parsed.origin)
  } catch {
    return false
  }
}

// Electron gold standard for window.open / shell.openExternal: pure URL
// validation without side effects (rate limiting lives in windowManager).
// Allows https anywhere, http solely for loopback dev servers.
export function isExternalOpenAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.username || parsed.password) return false
  if (!parsed.hostname || url.length > 2048) return false
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.host)) return false
  return true
}
