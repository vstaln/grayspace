import * as fs from 'fs'
import { dirname, join } from 'path'

/**
 * Writes JSON so a crash mid-write can never truncate the previous file: the
 * payload lands in a sibling temp file, is flushed to disk, and only then
 * replaces the target in one atomic rename.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${Date.now()}-${process.pid}.tmp`)
  const handle = fs.openSync(temp, 'w')
  try {
    fs.writeFileSync(handle, JSON.stringify(data, null, 2), 'utf8')
    // fsync before rename: rename is atomic, but only for bytes already on disk.
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    // Keep the previous good copy (DI-006): if the new file is ever corrupted
    // from outside, the last successful write is still recoverable.
    if (fs.existsSync(file)) fs.copyFileSync(file, backupPath(file))
    fs.renameSync(temp, file)
  } catch (err) {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* the temp file is disposable */
    }
    throw err
  }
}

/** Sibling of a store file holding the previous good write. */
export function backupPath(file: string): string {
  return `${file}.bak`
}

export type JsonRead<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'missing' | 'corrupt' }

/**
 * Reads and parses JSON without conflating a missing file with a corrupt one:
 * `missing` is a fresh profile (safe to start from defaults), `corrupt` means
 * the file exists but cannot be parsed (must never be silently overwritten).
 */
export function readJsonFile<T>(file: string): JsonRead<T> {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: 'missing' }
    // A permission/IO failure should not reset the store to defaults either.
    console.error(`cannot read store file ${file}:`, err)
    return { ok: false, error: 'missing' }
  }
  try {
    return { ok: true, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, error: 'corrupt' }
  }
}

/**
 * Store-file loader with the DI-001 guarantees: a corrupt file is quarantined
 * aside (so the next save cannot overwrite the evidence), the previous good
 * copy (`.bak`) is loaded when one exists, and only a genuinely missing file
 * falls back to defaults.
 */
export function readStoreJson<T>(file: string, fallback: T): T {
  const read = readJsonFile<T>(file)
  if (read.ok) return read.data
  if (read.error === 'missing') return fallback

  try {
    const quarantined = `${file}.corrupt-${Date.now()}`
    fs.renameSync(file, quarantined)
    console.error(`store file corrupted — quarantined to ${quarantined} (recovered from backup)`)
  } catch (err) {
    console.error(`failed to quarantine corrupt store file ${file}:`, err)
  }
  const backup = readJsonFile<T>(backupPath(file))
  if (backup.ok) return backup.data
  return fallback
}
