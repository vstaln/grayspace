import { randomBytes } from 'crypto'
import * as fs from 'fs'
import { join } from 'path'
import { getUserDataDir } from './userData.ts'


export const CONTROL_TOKEN_HEADER = 'x-orcspace-token'

let cached: string | null = null














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
    fs.mkdirSync(join(getUserDataDir()), { recursive: true })


    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    console.error('failed to persist the control token', err)
  }
  cached = token
  return token
}

export function tokenFile(): string {
  return join(getUserDataDir(), 'control-token')
}
