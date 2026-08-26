import type * as http from 'node:http'
import { CONTROL_PORT } from './config.ts'
import { controlToken } from './controlToken.ts'

export interface EmbeddedMcpStatus {
  running: boolean
  ready: boolean
  transport: 'embedded'
  lastError?: string
}

type Listener = (req: http.IncomingMessage, res: http.ServerResponse) => void

let listener: Listener | null = null
let status: EmbeddedMcpStatus = { running: false, ready: false, transport: 'embedded' }
let init: Promise<void> | null = null

/** Loads the existing MCP tools into the Electron main bundle without opening a second listener. */
export function startEmbeddedMcp(notify?: (value: EmbeddedMcpStatus) => void): void {
  if (init) return
  process.env.WORKSPACE_CONTROL_PORT = String(CONTROL_PORT)
  process.env.ORCSPACE_CONTROL_TOKEN = controlToken()
  init = (async () => {
    try {
      process.env.ORCSPACE_EMBEDDED = '1'
      const runtime = await import('../../Orcspace-mcp/src/index.ts')
      listener = runtime.createMcpRequestListener()
      status = { running: true, ready: true, transport: 'embedded' }
      notify?.(status)
    } catch (error) {
      status = { running: false, ready: false, transport: 'embedded', lastError: String(error) }
      notify?.(status)
      console.error('embedded MCP runtime failed to initialize', error)
    }
  })()
}

export function embeddedMcpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (listener) return listener(req, res)
  void init?.then(() => listener ? listener(req, res) : res.end(JSON.stringify({ error: 'MCP runtime is not ready' })))
}

export function embeddedMcpStatus(): EmbeddedMcpStatus { return { ...status } }
export function isEmbeddedMcpRunning(): boolean { return status.running && status.ready }
export async function restartEmbeddedMcp(): Promise<EmbeddedMcpStatus> { return embeddedMcpStatus() }
export function stopEmbeddedMcp(): void { listener = null; status = { running: false, ready: false, transport: 'embedded' } }
