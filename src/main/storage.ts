import * as electron from 'electron'
import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
const storageModuleDir = dirname(fileURLToPath(import.meta.url))

/**
 * Writes JSON so a crash mid-write can never truncate the previous file: the
 * payload lands in a sibling temp file, is flushed to disk, and only then
 * replaces the target in one atomic rename.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  writeAtomic(file, JSON.stringify(data, null, 2), true)
}

type NativeStorageCore = {
  /** Newer binding: takes the already-serialized text (see below). */
  writeTextAtomic?(path: string, text: string, keepBackup: boolean): Promise<void>
  sanitizeScrollback?(text: string, limit: number): string
}
const nativeStorageCore = ((): NativeStorageCore | null => {
  try {
    const require = createRequire(import.meta.url)
    // Mirrors the load pattern used by canvas-core/brain-core (see canvasState.ts):
    // packaged builds ship native/* under resourcesPath, dev builds resolve relative to source.
    const nativeDir = electronApp?.isPackaged
      ? join(process.resourcesPath, 'native', 'storage-core')
      : join(storageModuleDir, '../../native/storage-core')
    return require(nativeDir) as NativeStorageCore
  } catch (error) {
    console.warn('[native] storage-core unavailable; using the async JS atomic-write fallback.', error)
    return null
  }
})()

/**
 * ANSI-strip + byte-tail for scrollback persistence via Rust when the binding
 * is new enough to export it; returns null otherwise so the caller falls back
 * to its pure-JS twin (an old prebuilt binary keeps working unchanged).
 */
export function sanitizeScrollbackNative(text: string, limit: number): string | null {
  const fn = nativeStorageCore?.sanitizeScrollback
  if (typeof fn !== 'function') return null
  try {
    return fn.call(nativeStorageCore, text, limit)
  } catch (error) {
    console.warn('[native] sanitizeScrollback failed; using the JS fallback.', error)
    return null
  }
}

/**
 * Non-blocking counterpart to `writeJsonAtomic`: same crash-safety guarantees
 * (temp file + fsync + rename, `.bak` kept), but never blocks the main
 * process's event loop. Use this on hot, frequently-debounced save paths
 * (e.g. canvas autosave while the user is actively dragging/drawing) where a
 * synchronous multi-megabyte `JSON.stringify` + `writeFileSync` would stall
 * IPC/PTY handling for the duration of the write. Prefers the native Rust
 * writer (off-thread temp file + fsync + rename) when built; otherwise uses
 * non-blocking `fs.promises` calls, which also keep the disk work off the
 * event loop.
 *
 * NOT for paths that must be guaranteed durable before the process exits
 * (e.g. `before-quit` flushes) — those should keep using the synchronous
 * `writeJsonAtomic` so Electron does not tear down mid-write.
 *
 * Serialization happens here, in V8, and the *text* is what crosses into Rust.
 * The native binding used to take the object and let napi build a
 * `serde_json::Value` from it — but that conversion runs on the JS thread
 * before the async task is queued, and for one full canvas (200k stroke
 * points) it blocked the main process for ~176 ms per autosave versus ~40 ms
 * for `JSON.stringify` of the same object. The nominally non-blocking writer
 * was the biggest main-thread stall on the drawing path.
 */
export async function writeJsonAtomicAsync(file: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2)
  const writeText = nativeStorageCore?.writeTextAtomic
  if (typeof writeText === 'function') {
    try {
      await writeText.call(nativeStorageCore, file, text, true)
      return
    } catch (error) {
      console.warn('[native] storage-core write failed; falling back to the async JS writer.', error)
    }
  }
  await writeAtomicAsync(file, text, true)
}

async function writeAtomicAsync(file: string, text: string, keepBackup: boolean): Promise<void> {
  const dir = dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const handle = await fsp.open(temp, 'wx')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    if (keepBackup) {
      try {
        await fsp.copyFile(file, backupPath(file))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    await fsp.rename(temp, file)
  } catch (err) {
    try {
      await handle.close()
    } catch {
      /* already closed */
    }
    try {
      await fsp.unlink(temp)
    } catch {
      /* the temp file is disposable */
    }
    throw err
  }
}

/** Writes UTF-8 text through the same fsync-and-rename crash-safe path as JSON. */
export function writeTextAtomic(file: string, text: string): void {
  writeAtomic(file, text, false)
}

/** Non-blocking counterpart to `writeTextAtomic` (no `.bak`, same crash safety).
 *  Terminal scrollback snapshots go through here on every save, so they take
 *  the same off-thread Rust writer when one is built. */
export async function writeTextAtomicAsync(file: string, text: string): Promise<void> {
  const writeText = nativeStorageCore?.writeTextAtomic
  if (typeof writeText === 'function') {
    try {
      await writeText.call(nativeStorageCore, file, text, false)
      return
    } catch (error) {
      console.warn('[native] storage-core write failed; falling back to the async JS writer.', error)
    }
  }
  await writeAtomicAsync(file, text, false)
}

function writeAtomic(file: string, text: string, keepBackup: boolean): void {
  const dir = dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  // Include cryptographic entropy: multiple synchronous callers can still
  // share a millisecond timestamp, and a collision must never truncate a
  // sibling write's temporary payload.
  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const handle = fs.openSync(temp, 'wx')
  try {
    fs.writeFileSync(handle, text, 'utf8')
    // fsync before rename: rename is atomic, but only for bytes already on disk.
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    // Keep the previous good copy (DI-006): if the new file is ever corrupted
    // from outside, the last successful write is still recoverable.
    if (keepBackup && fs.existsSync(file)) fs.copyFileSync(file, backupPath(file))
    fs.renameSync(temp, file)
  } catch (err) {
    try {
      fs.closeSync(handle)
    } catch {
      /* already closed */
    }
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
    // EACCES/EBUSY/EPERM is not corruption: quarantining the file would let
    // the next save write defaults over a store we could not read.
    console.error(`cannot read store file ${file}:`, err)
    throw err
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (parsed === null || typeof parsed !== 'object') return { ok: false, error: 'corrupt' }
    return { ok: true, data: parsed as T }
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
