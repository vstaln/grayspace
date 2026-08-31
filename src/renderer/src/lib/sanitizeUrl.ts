/**
 * URL sanitization for markdown and user-provided links.
 * Blocks `javascript:`, `data:`, `vbscript:`, `file:` and other dangerous protocols
 * while allowing http/https, mailto, tel, relative URLs and fragments.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

// Protocols that must always be blocked, even if allow-listed elsewhere
const BLOCKED_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'])

function normalizeProtocol(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Detect `protocol:` at start, allowing leading whitespace/control chars
  // e.g. "  javascript:alert(1)" or "JaVaScRiPt:" or "javascript&colon;"
  // We only handle literal colon check; HTML entity decoding is caller's job.
  const match = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*)\s*:/.exec(trimmed)
  if (!match) return null
  return `${match[1].toLowerCase()}:`
}

/**
 * Returns true if the URL uses an allowed protocol or is a safe relative URL.
 * Relative URLs, fragments (#anchor), and root-relative (/path) are allowed.
 */
export function isSafeUrl(url: string): boolean {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed) return false

  // Fragments and relative URLs are safe (no protocol)
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true

  // Normalized check for obfuscated javascript: with whitespace
  const compact = trimmed.replace(/\s+/g, '').toLowerCase()
  if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')) return false

  const proto = normalizeProtocol(trimmed)
  if (!proto) {
    // No protocol -> relative URL like "page" or "path/to/file"
    // Treat as safe; the caller can decide to restrict further.
    // However block if it looks like protocol with disallowed scheme without colon detection due to spaces?
    // Already handled compact check above.
    return true
  }

  if (BLOCKED_PROTOCOLS.has(proto)) return false
  if (ALLOWED_PROTOCOLS.has(proto)) return true

  // Any other protocol (e.g. ftp:, ssh:) is blocked by default for markdown links
  return false
}

/**
 * Returns the original URL if safe, otherwise returns null / fallback.
 * Use to guard `href` attributes.
 */
export function sanitizeUrl(url: string, fallback: string | null = null): string | null {
  if (!isSafeUrl(url)) return fallback
  // Also reject URLs that decode to dangerous protocols after URI decoding
  try {
    const decoded = decodeURI(url).replace(/\s+/g, '').toLowerCase()
    if (decoded.startsWith('javascript:') || decoded.startsWith('data:') || decoded.startsWith('vbscript:')) return fallback
  } catch {
    // decodeURI can throw on malformed sequences; treat as unsafe
    return fallback
  }
  return url.trim()
}

/**
 * Returns a sanitized `href` for use in `<a>` tags.
 * Returns `null` if the URL is not safe; caller should omit the href.
 */
export function safeHref(url: string): string | null {
  return sanitizeUrl(url, null)
}
