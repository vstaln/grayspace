export function isTrustedAppNavigation(
  url: string,
  options: { devUrl?: string; controlOrigin: string; rendererFile: string }
): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'orc:') return parsed.hostname === 'app'
    if (parsed.protocol === 'file:') {
      const normalizeFilePath = (value: string): string =>
        value.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1').toLowerCase()
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
