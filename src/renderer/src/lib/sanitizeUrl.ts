





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






export function linkTargetFor(url: string): '_blank' | undefined {
  const proto = normalizeProtocol(url.trim())
  if (proto === 'mailto:' || proto === 'tel:') return undefined
  return '_blank'
}
