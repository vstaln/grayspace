import { embeddedMcpStatus, isEmbeddedMcpRunning, restartEmbeddedMcp, startEmbeddedMcp, stopEmbeddedMcp } from './embeddedMcp.ts'

export interface McpStatus {
  running: boolean
  ready: boolean
  transport: 'embedded'
  lastError?: string
}

export function mcpStatus(): McpStatus { return embeddedMcpStatus() }
export function isMcpRunning(): boolean { return isEmbeddedMcpRunning() }
export function startMcpServer(notify?: (status: McpStatus) => void): void { startEmbeddedMcp(notify) }
export async function restartMcpServer(): Promise<McpStatus> { return restartEmbeddedMcp() }
export function stopMcpServer(): void { stopEmbeddedMcp() }
