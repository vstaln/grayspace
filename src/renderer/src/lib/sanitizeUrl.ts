/**
 * URL sanitization for markdown and user-provided links.
 * Blocks `javascript:`, `data:`, `vbscript:`, `file:` and other dangerous protocols
 * while allowing http/https, mailto, tel, relative URLs and fragments.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

// Protocols that must always be blocked, even if allow-listed elsewhere
const BLOCKED_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'])

export interface SanitizeOptions {
  /**
   * Allow relative URLs / fragments. Defaults to true on the web but false
   * inside Electron (`file://`), where a relative href would resolve against
   * the app bundle and leak local file access. Pass `true` explicitly to
   * opt back in for a caller that resolves them itself.
   */
  allowRelative?: boolean
}

function shouldAllowRelative(options?: SanitizeOptions): boolean {
  if (options?.allowRelative === true) return true
  if (options?.allowRelative === false) return false
  try {
    if (typeof window !== 'undefined' && window.location?.protocol === 'file:') return false
  } catch {
    /* non-DOM context — fall through to permissive default */
  }
  return true
}

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

/** Decode percent-escapes for protocol sniffing; never throws. */
function decodedForSniff(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    // Malformed `%` sequences: fall back to a lenient decode that leaves
    // the bad escape intact so the raw check below still runs.
    try {
      return decodeURI(raw)
    } catch {
      return raw
    }
  }
}

function looksDangerous(value: string): boolean {
  // Collapse ALL inner whitespace so `java\tscript:` / `java script:` can't
  // smuggle a blocked scheme past the prefix check.
  const compact = value.replace(/[\x00-\x1F\x7F\s]+/g, '').toLowerCase()
  return compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')
}

/**
 * Returns true if the URL uses an allowed protocol or is a safe relative URL.
 * Relative URLs, fragments (#anchor), and root-relative (/path) are allowed
 * unless `allowRelative` is false (the default inside Electron file://).
 */
export function isSafeUrl(url: string, options?: SanitizeOptions): boolean {
  if (typeof url !== 'string') return false
  // Trim + collapse inner whitespace runs so obfuscated schemes can't hide
  // behind padding; the compact form is used for sniffing below.
  const trimmed = url.trim().replace(/\s+/g, ' ')
  if (!trimmed) return false
  // Strip ASCII control chars (0x00-0x1F, 0x7F) that can obfuscate protocols like `java script:`
  const withoutControls = trimmed.replace(/[\x00-\x1F\x7F]+/g, '')
  if (!withoutControls) return false

  // Encoded payloads (`javascript%3A…`, `java%09script:`) must fail even
  // though the raw text has no visible scheme.
  if (looksDangerous(withoutControls)) return false
  if (looksDangerous(decodedForSniff(withoutControls))) return false

  // Fragments and relative URLs are safe (no protocol) — unless the caller
  // runs in an Electron file:// context without explicitly opting in.
  const allowRelative = shouldAllowRelative(options)
  if (withoutControls.startsWith('#') || withoutControls.startsWith('/') || withoutControls.startsWith('./') || withoutControls.startsWith('../')) {
    return allowRelative
  }

  const proto = normalizeProtocol(withoutControls)
  if (!proto) {
    // No protocol -> relative URL like "page" or "path/to/file"
    if (!allowRelative) return false
    return true
  }

  // A decoded scheme that differs from the raw one (e.g. `java%73cript:`)
  // is still the decoded scheme — check it too.
  try {
    const decodedProto = normalizeProtocol(decodedForSniff(withoutControls))
    if (decodedProto && BLOCKED_PROTOCOLS.has(decodedProto)) return false
    if (decodedProto && looksDangerous(decodedProto)) return false
  } catch {
    return false
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
export function sanitizeUrl(url: string, fallback: string | null = null, options?: SanitizeOptions): string | null {
  if (!isSafeUrl(url, options)) return fallback
  // Decode-aware gate: an encoded `javascript:` that slipped past the first
  // check must still fail here.
  const trimmed = url.trim()
  const withoutControls = trimmed.replace(/[\x00-\x1F\x7F]+/g, '')
  if (looksDangerous(decodedForSniff(withoutControls))) return fallback
  return trimmed
}

/**
 * Returns a sanitized `href` for use in `<a>` tags.
 * Returns `null` if the URL is not safe; caller should omit the href.
 */
export function safeHref(url: string, options?: SanitizeOptions): string | null {
  return sanitizeUrl(url, null, options)
}

/**
 * Target for a sanitized link. `mailto:`/`tel:` must NOT open a blank
 * browser tab (they hand off to the OS); http(s) links do.
 * Returns `'_blank'` for http(s), `undefined` for mailto:/tel:.
 */
export function linkTargetFor(url: string): '_blank' | undefined {
  const proto = normalizeProtocol(url.trim())
  if (proto === 'mailto:' || proto === 'tel:') return undefined
  return '_blank'
}
