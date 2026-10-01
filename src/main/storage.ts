import * as electron from 'electron'
import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
const storageModuleDir = dirname(fileURLToPath(import.meta.url))






export function writeJsonAtomic(file: string, data: unknown): void {
  writeAtomic(file, JSON.stringify(data, null, 2), true)
}

type NativeStorageCore = {

  writeTextAtomic?(path: string, text: string, keepBackup: boolean): Promise<void>
  sanitizeScrollback?(text: string, limit: number): string
}
const nativeStorageCore = ((): NativeStorageCore | null => {
  try {
    const require = createRequire(import.meta.url)


    const nativeDir = electronApp?.isPackaged
      ? join(process.resourcesPath, 'native', 'storage-core')
      : join(storageModuleDir, '../../native/storage-core')
    const platformArch = `${process.platform}-${process.arch}`
    if (!fs.readdirSync(nativeDir).some((name) => name.endsWith('.node') && name.includes(platformArch))) {
      return null
    }
    return require(nativeDir) as NativeStorageCore
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[native] storage-core unavailable; using the async JS atomic-write fallback (${reason})`)
    return null
  }
})()































export async function writeJsonAtomicAsync(file: string, data: unknown, isCurrent?: () => boolean): Promise<void> {
  const text = JSON.stringify(data, null, 2)
  if (isCurrent) return writeAtomicAsync(file, text, true, isCurrent)
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

async function writeAtomicAsync(file: string, text: string, keepBackup: boolean, isCurrent?: () => boolean): Promise<void> {
  const dir = dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const handle = await fsp.open(temp, 'wx', 0o600)
  try {
    try {
      await handle.chmod(0o600)
    } catch {
      // Filesystems without permission bits (some Windows/network mounts).
    }
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    if (isCurrent) {
      // Publication and its generation check must share one JS turn. A
      // queued rename could otherwise overwrite a newer synchronous save.
      if (!isCurrent()) {
        await fsp.unlink(temp)
        return
      }
      if (keepBackup && fs.existsSync(file)) fs.copyFileSync(file, backupPath(file))
      fs.renameSync(temp, file)
      return
    }
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

    }
    try {
      await fsp.unlink(temp)
    } catch {

    }
    throw err
  }
}


export function writeTextAtomic(file: string, text: string): void {
  writeAtomic(file, text, false)
}




export async function writeTextAtomicAsync(file: string, text: string, isCurrent?: () => boolean): Promise<void> {
  if (isCurrent) return writeAtomicAsync(file, text, false, isCurrent)
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



  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const handle = fs.openSync(temp, 'wx', 0o600)
  try {
    try {
      fs.fchmodSync(handle, 0o600)
    } catch {
      // Filesystems without permission bits (some Windows/network mounts).
    }
    fs.writeFileSync(handle, text, 'utf8')

    fs.fsyncSync(handle)
    fs.closeSync(handle)


    if (keepBackup && fs.existsSync(file)) fs.copyFileSync(file, backupPath(file))
    fs.renameSync(temp, file)
  } catch (err) {
    try {
      fs.closeSync(handle)
    } catch {

    }
    try {
      fs.unlinkSync(temp)
    } catch {

    }
    throw err
  }
}


export function backupPath(file: string): string {
  return `${file}.bak`
}

export type JsonRead<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'missing' | 'corrupt' }






export function readJsonFile<T>(file: string): JsonRead<T> {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: 'missing' }


    console.error(`cannot read store file ${file}:`, err)
    throw err
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''), (k: string, v: unknown) =>
      k === '__proto__' || k === 'prototype' || k === 'constructor' ? undefined : v
    )
    if (parsed === null || typeof parsed !== 'object') return { ok: false, error: 'corrupt' }
    return { ok: true, data: parsed as T }
  } catch {
    return { ok: false, error: 'corrupt' }
  }
}







export function sweepTempFiles(dir: string, maxAgeMs = 3_600_000): void {
  sweepTempFilesWithOptions(dir, { maxAgeMs })
}

/**
 * Quarantined store files (`<file>.corrupt-<ms>`, written by readStoreJson)
 * are kept for forensics, not forever. They are swept once older than
 * corruptMaxAgeMs (default 7 days), independently of the short temp-file age.
 */
export function sweepTempFilesWithOptions(
  dir: string,
  options: { maxAgeMs?: number; corruptMaxAgeMs?: number } = {}
): void {
  const maxAgeMs = options.maxAgeMs ?? 3_600_000
  const corruptMaxAgeMs = options.corruptMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    // Quarantined corrupt stores: <anything>.corrupt-<epochMs>. Swept on the
    // long clock (days, not the 1h temp age) so recent corruption stays
    // diagnosable while old forensics do not pile up.
    if (name.includes('.corrupt-')) {
      // Strict shape only — a blanket "corrupt" substring would let one
      // stray user file become deletable by the app.
      if (/\.corrupt-\d+$/.test(name)) {
        try {
          const full = join(dir, name)
          const stat = fs.statSync(full)
          if (now - stat.mtimeMs > corruptMaxAgeMs) fs.unlinkSync(full)
        } catch {

        }
      }
      continue
    }
    // Only this app's own temp shapes. A blanket /\.tmp$/ would also delete
    // whatever else happens to live in the user-data directory.
    //   atomic writes (JS and Rust storage-core): .<ms|nanos>-<pid>-<hex|dec>.tmp
    //   journal rotation (journalSink.ts):        <file>.<16 hex>.tmp
    const isAtomicTemp = /^\.\d+-\d+-[0-9a-f]+\.tmp$/i.test(name)
    const isJournalTemp = /^.+\.[0-9a-f]{16}\.tmp$/i.test(name)
    if (!isAtomicTemp && !isJournalTemp) continue
    try {
      const full = join(dir, name)
      const stat = fs.statSync(full)
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(full)
    } catch {

    }
  }
}

export function readStoreJson<T>(file: string, fallback: T): T {
  const read = readJsonFile<T>(file)
  if (read.ok) return read.data
  if (read.error === 'missing') {
    const backup = readJsonFile<T>(backupPath(file))
    if (backup.ok) return backup.data
    return fallback
  }

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
