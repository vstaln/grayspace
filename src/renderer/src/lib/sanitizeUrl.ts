





const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])


const BLOCKED_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'])

export interface SanitizeOptions {






  allowRelative?: boolean
}

function shouldAllowRelative(options?: SanitizeOptions): boolean {
  if (options?.allowRelative === true) return true
  if (options?.allowRelative === false) return false
  try {
    if (typeof window !== 'undefined' && window.location?.protocol === 'file:') return false
  } catch {

  }
  return true
}

function normalizeProtocol(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null



  const match = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*)\s*:/.exec(trimmed)
  if (!match) return null
  return `${match[1].toLowerCase()}:`
}


function decodedForSniff(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {


    try {
      return decodeURI(raw)
    } catch {
      return raw
    }
  }
}

function looksDangerous(value: string): boolean {


  const compact = value.replace(/[\x00-\x1F\x7F\s]+/g, '').toLowerCase()
  return compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')
}






// A single dotted word is just as likely to be a file name as a host, and the
// field accepts both. "report.pdf" must not quietly become a web address.
const FILE_LIKE = /\.(pdf|txt|md|markdown|json|ya?ml|toml|xml|csv|tsv|log|zip|tar|gz|7z|rar|png|jpe?g|gif|webp|svg|ico|bmp|mp[34]|wav|flac|m4a|mkv|mov|avi|webm|docx?|xlsx?|pptx?|exe|dll|dmg|iso|bat|cmd|ps1|sh|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h)$/i

/**
 * Give a scheme-less but host-shaped entry the https:// it obviously meant.
 *
 * Without this, "example.com" reaches isSafeUrl as a relative path: rejected
 * outright as unsafe when the renderer runs from file://, and otherwise stored
 * as a link that resolves against the app's own origin. Neither is what someone
 * pasting a hostname wanted. Anything already carrying a scheme, an explicit
 * path, or a Windows separator is returned untouched.
 */
export function withScheme(value: string): string {
  if (!value) return value
  // A colon followed by digits is a port, not a scheme. Without the lookahead
  // "localhost:5173" and "example.com:8080" read as the schemes "localhost:"
  // and "example.com:" and were handed back untouched.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(value)) return value
  if (value.startsWith('/') || value.startsWith('.') || value.startsWith('#')) return value
  if (value.includes('\\')) return value
  // Host-shaped: a dot-separated label run (or localhost), optional :port/path.
  if (!/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/.test(value)) return value
  // A path, a port or www. settles it; a bare "name.ext" does not.
  const bareHost = !/[/?#:]/.test(value)
  if (bareHost && !value.startsWith('www.') && FILE_LIKE.test(value)) return value
  return `https://${value}`
}



export function isSafeUrl(url: string, options?: SanitizeOptions): boolean {
  if (typeof url !== 'string') return false


  const trimmed = url.trim().replace(/\s+/g, ' ')
  if (!trimmed) return false

  const withoutControls = trimmed.replace(/[\x00-\x1F\x7F]+/g, '')
  if (!withoutControls) return false



  if (looksDangerous(withoutControls)) return false
  if (looksDangerous(decodedForSniff(withoutControls))) return false



  const allowRelative = shouldAllowRelative(options)
  if (withoutControls.startsWith('#') || withoutControls.startsWith('/') || withoutControls.startsWith('./') || withoutControls.startsWith('../')) {
    return allowRelative
  }

  const proto = normalizeProtocol(withoutControls)
  if (!proto) {

    if (!allowRelative) return false
    return true
  }



  try {
    const decodedProto = normalizeProtocol(decodedForSniff(withoutControls))
    if (decodedProto && BLOCKED_PROTOCOLS.has(decodedProto)) return false
    if (decodedProto && looksDangerous(decodedProto)) return false
  } catch {
    return false
  }

  if (BLOCKED_PROTOCOLS.has(proto)) return false
  if (ALLOWED_PROTOCOLS.has(proto)) return true


  return false
}





export function sanitizeUrl(url: string, fallback: string | null = null, options?: SanitizeOptions): string | null {
  if (!isSafeUrl(url, options)) return fallback


  const trimmed = url.trim()
  const withoutControls = trimmed.replace(/[\x00-\x1F\x7F]+/g, '')
  if (looksDangerous(decodedForSniff(withoutControls))) return fallback
  return trimmed
}





export function safeHref(url: string, options?: SanitizeOptions): string | null {
  return sanitizeUrl(url, null, options)
}
