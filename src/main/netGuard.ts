import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'



















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

  return (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    /^127(?:\.\d+){3}$/.test(name) ||
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
