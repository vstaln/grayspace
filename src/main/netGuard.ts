import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'



















function parseIpv4Part(part: string): number | null {
  if (!part) return null
  let base = 10
  let digits = part
  if (/^0x[0-9a-f]+$/i.test(part)) {
    base = 16
    digits = part.slice(2)
  } else if (/^0[0-7]*$/.test(part) && part.length > 1) {
    base = 8
    digits = part.slice(1) || '0'
  } else if (!/^\d+$/.test(part)) {
    return null
  }
  const value = parseInt(digits, base)
  if (!Number.isInteger(value) || value < 0 || value > 255) return null
  return value
}

function ipv4ToInt32(host: string): number | null {
  const clean = host.trim().toLowerCase()
  if (!clean) return null
  // Single-number forms: 2130706433, 0x7f000001, 017700000001
  if (/^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(clean)) {
    let base = 10
    let digits = clean
    if (/^0x/i.test(clean)) {
      base = 16
      digits = clean.slice(2)
    } else if (/^0\d*$/.test(clean) && clean.length > 1) {
      // Could be octal or decimal with leading zero; try strict octal first.
      if (/^0[0-7]+$/.test(clean)) {
        base = 8
        digits = clean.slice(1)
      }
    }
    const value = parseInt(digits, base)
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null
    return value >>> 0
  }
  const parts = clean.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    const value = parseIpv4Part(part)
    if (value === null) return null
    bytes.push(value)
  }
  return (((bytes[0] * 256 + bytes[1]) * 256 + bytes[2]) * 256 + bytes[3]) >>> 0
}

function isLoopbackIpv4(host: string): boolean {
  const int = ipv4ToInt32(host)
  if (int === null) return false
  // 127.0.0.0/8
  return (int >>> 24) === 127
}

export function isLoopbackHost(host: string): boolean {
  let name = host.trim().toLowerCase()
  if (!name) return false

  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    if (end <= 1) return false
    name = name.slice(1, end)
  } else {
    const first = name.indexOf(':')
    const last = name.lastIndexOf(':')

    if (first > 0 && first === last) name = name.slice(0, first)
  }

  if (name === 'localhost') return true
  // IPv4-mapped IPv6 loopback ::ffff:127.x.x.x
  if (name.startsWith('::ffff:')) {
    const tail = name.slice('::ffff:'.length)
    if (isLoopbackIpv4(tail)) return true
  }

  if (isLoopbackIpv4(name)) return true
  return (
    name === '::1' ||
    name === '0:0:0:0:0:0:0:1'
  )
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'orc:') {
      return parsed.hostname === 'app'
    }
    return isLoopbackHost(parsed.host)
  } catch {
    return false
  }
}





export function isLoopbackRequest(req: { headers: { host?: unknown; origin?: unknown }; socket?: { remoteAddress?: string } }): boolean {

  if (req.socket && req.socket.remoteAddress === undefined) {
    // Named-pipe/Unix-socket transport has no remote IP: still require the
    // Host header (when present) to be loopback so a smuggled Host like
    // 2130706433 cannot bypass the check.
    const host = req.headers.host
    if (typeof host === 'string' && host && !isLoopbackHost(host)) return false
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '' && !isLoopbackUrl(origin)) return false
    return true
  }
  const host = req.headers.host
  if (typeof host !== 'string' || !host || !isLoopbackHost(host)) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && !isLoopbackUrl(origin)) return false
  return true
}


export function applyLoopbackCors(
  req: { headers: { origin?: unknown } },
  res: { setHeader(name: string, value: string): void },
  allowHeaders = 'Content-Type'
): void {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !origin || !isLoopbackUrl(origin)) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', allowHeaders)
  res.setHeader('Access-Control-Max-Age', '600')
}







export function secretsEqual(a: string, b: string): boolean {


  if (a.length > 1024 || b.length > 1024) return false
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return cryptoTimingSafeEqual(ha, hb)
}
