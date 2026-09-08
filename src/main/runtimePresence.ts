import * as fs from 'fs'
import { join } from 'path'
import { getUserDataDir } from './userData.ts'
import { buildPresence } from './linkSnapshot.ts'

export const RUNTIME_FILE_NAME = 'runtime.json'

export function runtimeFile(): string {
  return join(getUserDataDir(), RUNTIME_FILE_NAME)
}





export function writeRuntimePresence(input: {
  workspaceDir: string | null | undefined
}): string {
  const payload = {
    ...buildPresence({ workspaceDir: input.workspaceDir }),
    writtenAt: Date.now()
  }
  const dir = getUserDataDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = runtimeFile()
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return file
}

export function clearRuntimePresence(): void {
  try {
    fs.unlinkSync(runtimeFile())
  } catch {

  }
}

export function readRuntimePresence(): ReturnType<typeof buildPresence> & { writtenAt?: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimeFile(), 'utf8')) as ReturnType<typeof buildPresence> & {
      writtenAt?: number
    }
    if (!raw || raw.app !== 'orcspace') return null
    return raw
  } catch {
    return null
  }
}
