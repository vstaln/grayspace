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

/**
 * Where the `orc` shim lives.
 *
 * Packaged builds ship `cli/` under `resourcesPath` (see `extraResources` in
 * package.json); dev builds resolve it relative to the compiled main bundle in
 * `out/main`. Same pattern the native modules use, for the same reason: there
 * is no single path that is correct in both.
 */
export function orcCliDir(): string {
  if (cachedDir) return cachedDir
  const candidates = electronApp?.isPackaged
    ? [join(process.resourcesPath, 'cli')]
    : [join(moduleDir, '../../cli'), join(process.cwd(), 'cli')]
  cachedDir = candidates.find((dir) => fs.existsSync(join(dir, 'orc.mjs'))) ?? candidates[0]
  return cachedDir
}

/**
 * Makes the POSIX shim executable.
 *
 * Windows ignores the mode, and on macOS the bit usually survives packaging —
 * but "usually" is not good enough for the one file every agent depends on,
 * and a lost +x bit fails as `permission denied` from a shim that is visibly
 * right there, which is a miserable thing to debug.
 */
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

/**
 * The environment every agent terminal is spawned with.
 *
 * Three variables and a PATH entry are the entire integration surface: an
 * agent types `orc ...`, the shim runs on the app's own Node, and the CLI
 * already knows which app to talk to, with what token, and as whom. Nothing is
 * written to the user's shell profile and nothing survives the terminal.
 */
export function orcTerminalEnv(terminalId: string): Record<string, string> {
  const dir = orcCliDir()
  const path = process.env.PATH ?? process.env.Path ?? ''
  return {
    // Prepended, not appended: an `orc` earlier on the user's PATH would
    // otherwise shadow the one bound to this running instance.
    PATH: path ? `${dir}${delimiter()}${path}` : dir,
    ORCSPACE_SOCKET_PATH: getIpcSocketPath(),
    ORCSPACE_URL: `http://127.0.0.1:${CONTROL_PORT}`,
    ORCSPACE_TOKEN: controlToken(),
    ORCSPACE_AGENT_ID: terminalId,
    // Electron's binary doubles as the Node runtime for the shim.
    ORCSPACE_NODE: process.execPath
  }
}

function delimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}
