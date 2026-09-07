import * as os from 'os'
import * as fs from 'fs'
import { join } from 'path'

let activeSocketPath: string | null = null

export function isDevEnvironment(): boolean {
  return Boolean(
    process.env['ELECTRON_RENDERER_URL'] ||
    process.env.NODE_ENV === 'development' ||
    process.env.ORCSPACE_DEV_USER_DATA
  )
}

/**
 * Standard Named Pipe (Windows) / Unix Domain Socket (macOS/Linux)
 * used for zero-port, in-memory IPC with the `orc` CLI and other local tools.
 */
export function getIpcSocketPath(isDev = isDevEnvironment()): string {
  if (activeSocketPath) {
    return activeSocketPath
  }
  if (process.env.ORCSPACE_SOCKET_PATH) {
    return process.env.ORCSPACE_SOCKET_PATH
  }
  const suffix = isDev ? '-dev' : ''
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\orcspace${suffix}`
  }
  return join(os.tmpdir(), `orcspace${suffix}.sock`)
}

export function setActiveSocketPath(socketPath: string): void {
  activeSocketPath = socketPath
}

/**
 * Prepares the socket path by unlinking any dead Unix domain socket file
 * leftover from an ungraceful process crash.
 */
export function prepareSocketPath(socketPath: string): void {
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // ignore
    }
  }
}

