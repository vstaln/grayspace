import { randomBytes } from 'crypto'
import * as fs from 'fs'
import { join } from 'path'
import { getUserDataDir } from './userData.ts'
import { writeFileAtomicSync } from './atomicFile.ts'
import { notifyPersistError } from './persistNotifier.ts'


export const CONTROL_TOKEN_HEADER = 'x-orcspace-token'

let cached: string | null = null

/** Set when the token could not be written to disk; see controlToken(). */
let persistError: string | null = null














export function controlToken(): string {
  if (cached) return cached
  const file = tokenFile()
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) {
      cached = existing
      return cached
    }
  } catch {

  }
  const token = randomBytes(32).toString('hex')
  try {
    // Atomic + fsynced: controlToken() runs inside app.whenReady() before the
    // window exists, and every `orc` client reads this file. A torn write
    // turns into universal 401s with no window to explain them. 0600 because
    // this token is the only thing standing between a local process and the
    // full control API.
    writeFileAtomicSync(file, token, { mode: 0o600, ensureDir: getUserDataDir() })
  } catch (err) {
    // The token is still cached and returned, so the window and every IPC
    // path keep working — but `orc` reads this file, so nothing that goes
    // through the control server will authenticate. Every agent command fails
    // with "a valid control token is required", which is true and points
    // nowhere near the cause.
    //
    // Throwing is not the answer either: this runs inside app.whenReady(),
    // before createWindow(), so an exception leaves the app with no window and
    // no explanation at all.
    //
    // So the failure is recorded and pushed through the persist-error channel
    // that already surfaces a toast, and remembered so the 401 can say what
    // actually happened.
    persistError = err instanceof Error ? err.message : String(err)
    notifyPersistError('control-token', err)
  }
  cached = token
  return token
}

/**
 * Why the control token could not be written, if it could not be.
 *
 * The control server reads this to turn an unexplained 401 into the actual
 * cause.
 */
export function controlTokenPersistError(): string | null {
  return persistError
}

export function tokenFile(): string {
  return join(getUserDataDir(), 'control-token')
}
