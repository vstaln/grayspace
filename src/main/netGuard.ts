import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'

/**
 * Network-edge checks shared by the control server (and mirrored in the MCP
 * process). Kept free of Electron so unit tests can exercise them.
 */

/**
 * True when `host` is a loopback address or name.
 *
 * Host headers come in several shapes:
 * - `127.0.0.1:7421`, `localhost:7421`
 * - `[::1]:7421` (IPv6 with port, RFC 3986)
 * - `::1` (bare IPv6, no port — common on some stacks)
 *
 * A naïve `replace(/:\d+$/, '')` corrupts bare `::1` into `:` (the final `:1`
 * looks like a port), which would reject legitimate loopback and accept only
 * bracketed forms. Parse brackets first; only strip a port when there is a
 * single colon (IPv4 / hostname form).
 */
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
    // Exactly one colon → host:port (IPv4 or hostname). Multiple colons → raw IPv6.
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
    return isLoopbackHost(new URL(value).host)
  } catch {
    return false
  }
}

/**
 * Host is loopback, and if an Origin is present it is also loopback.
 * `file://` sends `Origin: null` — that is not loopback and must not pass.
 */
export function isLoopbackRequest(req: { headers: { host?: unknown; origin?: unknown } }): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || !host || !isLoopbackHost(host)) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && !isLoopbackUrl(origin)) return false
  return true
}

/** Echo a loopback Origin so a local dashboard page can call this server. */
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

/**
 * Constant-time string compare for secrets.
 *
 * Direct `crypto.timingSafeEqual` on the raw strings leaks length via early
 * return; hashing both to fixed-size digests removes that channel.
 */
export function secretsEqual(a: string, b: string): boolean {
  // Bound hashing work pre-auth: a multi-megabyte header would otherwise burn
  // CPU on every unauthenticated request. Real tokens are far shorter.
  if (a.length > 1024 || b.length > 1024) return false
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return cryptoTimingSafeEqual(ha, hb)
}
