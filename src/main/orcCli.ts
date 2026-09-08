import * as electron from 'electron'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { CONTROL_PORT } from './config.ts'
import { getIpcSocketPath } from './ipcSocket.ts'
import { controlToken } from './controlToken.ts'

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
const moduleDir = dirname(fileURLToPath(import.meta.url))

let cachedDir: string | null = null









export function orcCliDir(): string {
  if (cachedDir) return cachedDir
  const candidates = electronApp?.isPackaged
    ? [join(process.resourcesPath, 'cli')]
    : [join(moduleDir, '../../cli'), join(process.cwd(), 'cli')]
  cachedDir = candidates.find((dir) => fs.existsSync(join(dir, 'orc.mjs'))) ?? candidates[0]
  return cachedDir
}









export function ensureOrcExecutable(): void {
  if (process.platform === 'win32') return
  const shim = join(orcCliDir(), 'orc')
  try {
    const mode = fs.statSync(shim).mode
    if ((mode & 0o111) !== 0o111) fs.chmodSync(shim, 0o755)
  } catch (err) {
    console.warn('could not make the orc shim executable', err)
  }
}









export function orcTerminalEnv(terminalId: string): Record<string, string> {
  const dir = orcCliDir()
  const path = process.env.PATH ?? process.env.Path ?? ''
  return {


    PATH: path ? `${dir}${delimiter()}${path}` : dir,
    ORCSPACE_SOCKET_PATH: getIpcSocketPath(),
    ORCSPACE_URL: `http://127.0.0.1:${CONTROL_PORT}`,
    ORCSPACE_TOKEN: controlToken(),
    ORCSPACE_AGENT_ID: terminalId,

    ORCSPACE_NODE: process.execPath
  }
}

function delimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}
