import * as http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCP_PORT, TOKEN_HEADER, tokenMatches } from './control.js'

const MAX_BODY_BYTES = 1_000_000
const BODY_TIMEOUT_MS = 30_000

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).host)
  } catch {
    return false
  }
}

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || !isLoopbackHost(host)) return false
  const origin = req.headers.origin
  return typeof origin !== 'string' || origin === '' || isLoopbackUrl(origin)
}

function isLoopbackHost(host: string): boolean {
  // Host headers come as host:port, [ipv6]:port, or bare ::1. A naïve
  // /:\d+$/ strip corrupts bare IPv6 "::1" into ":" (the final ":1" looks
  // like a port) and would reject legitimate loopback traffic.
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
    name === '::1' ||
    name === '0:0:0:0:0:0:0:1'
  )
}

/**
 * A JSON-RPC error framed the same way the SDK would frame it, in whichever
 * content type the client asked for (plain JSON or SSE) — used for protocol
 * errors the SDK itself would otherwise report as a 200 + isError result.
 */
function writeJsonRpcError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: unknown,
  code: number,
  message: string
): void {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const accept = String(req.headers.accept ?? '')
  if (accept.includes('text/event-stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`event: message\ndata: ${payload}\n\n`)
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(payload)
  }
}

/**
 * Same policy as the app's control server: binding to loopback keeps the
 * network out, but any website the user visits can POST to 127.0.0.1 from
 * JavaScript. Browsers attach `Origin` to exactly those cross-site requests,
 * so refusing any non-loopback origin (and the `null` origin of sandboxed
 * iframes) closes that hole while leaving the CLI agents — codex/opencode/
 * claude send no Origin at all — untouched. The Host check blocks a
 * DNS-rebinding domain resolving to 127.0.0.1. The final gate is the shared
 * token (P1): this server can open shells, so every request must prove it
 * knows the secret the app injected into this process's environment.
 */
function isTrustedRequest(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && !isLoopbackUrl(origin)) return false
  const host = req.headers.host
  if (typeof host === 'string' && host && !isLoopbackHost(host)) return false
  const presented = req.headers[TOKEN_HEADER]
  return tokenMatches(Array.isArray(presented) ? presented[0] : presented)
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Buffers are collected whole and decoded once at the end — decoding each
    // chunk on its own (e.g. via `raw += chunk`) can split a multi-byte UTF-8
    // character across a chunk boundary and silently corrupt it.
    const chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = false
    let timedOut = false
      const timer = setTimeout(() => {
      timedOut = true
      req.destroy()
      reject(new Error('request body timed out'))
    }, BODY_TIMEOUT_MS)
    req.on('data', (chunk: Buffer) => {
      // Once the cap is hit the remaining bytes are dropped, so memory stays
      // bounded no matter how long the client keeps uploading.
      if (tooLarge || timedOut) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(timer)
      if (tooLarge || timedOut) return
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Builds the `/mcp` request listener for a stateless MCP server: a fresh server/transport pair per request. */
export function createRequestListener(
  createServer: () => McpServer,
  toolNames: Set<string>
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      // The MCP clients are CLI agents that send no Origin at all. Only a
      // loopback origin may be echoed back; anything else gets no CORS header,
      // so even a browser that ignores the 403 cannot read the response.
      const origin = req.headers.origin
      if (typeof origin === 'string' && isLoopbackUrl(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, x-orcspace-token')

      if (req.method === 'OPTIONS') {
        if (isLoopbackRequest(req)) {
          res.writeHead(204)
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' })
        }
        res.end()
        return
      }

      if (!isTrustedRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'cross-origin requests are not accepted' } }))
        return
      }

      if (req.url !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found, use /mcp' }))
        return
      }

      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined
        // P2-003b: an unknown tool name is a protocol error (-32602), not a tool
        // execution result. Checked before the server is created so the SDK's
        // isError-style answer never reaches the client.
        if (body && typeof body === 'object') {
          const rpc = body as { method?: unknown; params?: { name?: unknown }; id?: unknown }
          if (rpc.method === 'tools/call' && typeof rpc.params?.name === 'string' && !toolNames.has(rpc.params.name)) {
            writeJsonRpcError(req, res, rpc.id, -32602, `Tool ${rpc.params.name} not found`)
            return
          }
        }
        // Stateless: each request gets a fresh server/transport pair, so clients
        // can connect and disconnect freely without leaking sessions.
        const server = createServer()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          void transport.close()
          void server.close()
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch (err) {
        console.error('mcp request failed', err)
        if (res.headersSent) return
        // A body that never arrived, or arrived past the cap, is a transport
        // problem — not a JSON-RPC protocol error — so it answers with its own
        // status and a clear message instead of the generic 500.
        if (err instanceof SyntaxError) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        const status = message.includes('too large') ? 413 : message.includes('timed out') ? 408 : 500
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
        // The body was abandoned mid-flight (oversized or stalled upload);
        // close the socket as soon as the response has flushed so the client
        // cannot keep the connection alive.
        if (status === 413 || status === 408) {
          res.on('finish', () => req.destroy())
        }
      }
    })()
  }
}

/**
 * Bound to both loopback addresses explicitly, rather than the name
 * 'localhost': `.listen(port, 'localhost')` resolves the name once and binds
 * only that single address, and on this machine that resolved to the IPv6
 * address alone — the port showed as listening, yet a client whose own
 * resolver preferred 127.0.0.1 got ECONNREFUSED. Binding both addresses lets
 * every config keep using the human-readable `localhost` in the URL while
 * staying correct regardless of which family a given client resolves it to.
 * A platform with IPv6 turned off simply fails the second bind, which is
 * logged and ignored — IPv4 alone is still a fully working server.
 */
export function listenOnLoopback(server: http.Server, address: string): http.Server {
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`mcp port ${MCP_PORT} on ${address} is already in use`)
      return
    }
    console.warn(`workspace-mcp-server: could not bind ${address}:${MCP_PORT}`, err.message)
  })
  server.listen(MCP_PORT, address, () => {
    console.log(`workspace-mcp-server listening on http://localhost:${MCP_PORT}/mcp (${address})`)
  })
  return server
}
