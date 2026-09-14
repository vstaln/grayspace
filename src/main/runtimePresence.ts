import * as fs from 'fs'
import { join } from 'path'
import { getUserDataDir } from './userData.ts'
import { writeFileAtomicSync } from './atomicFile.ts'
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
  const file = runtimeFile()
  // Atomic + fsynced: a torn runtime.json makes the CLI report "offline"
  // while the app is running (cli/orc.mjs JSON.parse path). 0600 keeps the
  // socket path and port readable only by the user who owns the session.
  writeFileAtomicSync(file, JSON.stringify(payload, null, 2) + '\n', {
    mode: 0o600,
    ensureDir: getUserDataDir()
  })
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
