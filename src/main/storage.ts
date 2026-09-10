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
    return require(nativeDir) as NativeStorageCore
  } catch (error) {
    console.warn('[native] storage-core unavailable; using the async JS atomic-write fallback.', error)
    return null
  }
})()






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



  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const handle = fs.openSync(temp, 'wx')
  try {
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
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!/^\.\d+-\d+-[0-9a-f]+\.tmp$/.test(name)) continue
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
