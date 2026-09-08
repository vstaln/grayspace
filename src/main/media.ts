import * as electron from 'electron'
import { createHash } from 'crypto'

const clipboard = (electron as unknown as { clipboard?: typeof electron.clipboard }).clipboard
import * as fs from 'fs'
import * as os from 'os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getUserDataDir } from './userData.ts'


export interface MediaFile {
  name: string
  path: string
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp'


}

export const IMAGE_EXTENSIONS = Object.keys(MIME_BY_EXT)

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  weba: 'audio/webm'
}

export const AUDIO_EXTENSIONS = Object.keys(AUDIO_MIME_BY_EXT)


const MEDIA_MIME_BY_EXT: Record<string, string> = { ...MIME_BY_EXT, ...AUDIO_MIME_BY_EXT }


export const MAX_MEDIA_BYTES = 24 * 1024 * 1024


export function mimeTypeForPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase()
  return MEDIA_MIME_BY_EXT[ext] || 'application/octet-stream'
}






export function mediaDir(): string {
  return join(getUserDataDir(), 'media')
}





export function saveBytes(bytes: Buffer, ext: string): MediaFile {
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  const clean = ext.replace(/^\./, '').toLowerCase()
  const safeExt = MIME_BY_EXT[clean] || AUDIO_MIME_BY_EXT[clean] ? clean : 'png'
  const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  const dir = mediaDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = `${digest}.${safeExt}`
  const path = join(dir, name)

  if (!fs.existsSync(path)) fs.writeFileSync(path, bytes)
  return { name, path }
}


export function importFile(source: string): MediaFile {
  if (!isLocalPath(source)) throw new Error('UNC and remote paths are not allowed')
  const bytes = fs.readFileSync(source)
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  return saveBytes(bytes, extname(source))
}


export function saveClipboardImage(): MediaFile | null {
  if (!clipboard) return null
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const bytes = image.toPNG()
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  return saveBytes(bytes, 'png')
}


export function scratchDir(): string {
  return join(os.tmpdir(), 'orcspace-clipboard')
}









export const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000






export function pruneScratch(dir: string = scratchDir()): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - SCRATCH_TTL_MS
  for (const name of entries) {
    const path = join(dir, name)
    try {
      if (fs.statSync(path).mtimeMs < cutoff) fs.unlinkSync(path)
    } catch {

    }
  }
}


export function saveBytesToScratch(bytes: Buffer, ext: string): MediaFile {
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  const clean = ext.replace(/^\./, '').toLowerCase()
  const safeExt = MIME_BY_EXT[clean] || AUDIO_MIME_BY_EXT[clean] ? clean : 'png'
  const dir = scratchDir()
  fs.mkdirSync(dir, { recursive: true })
  pruneScratch(dir)
  const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  const name = `${digest}.${safeExt}`
  const path = join(dir, name)
  if (!fs.existsSync(path)) fs.writeFileSync(path, bytes)
  return { name, path }
}












export function saveClipboardImageToScratch(): MediaFile | null {
  if (!clipboard) return null
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const bytes = image.toPNG()
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')


  return saveBytesToScratch(bytes, 'png')
}









export function isLocalPath(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) return false
  return isAbsolute(path)
}















export async function dataUrl(path: string): Promise<string | null> {
  if (!isLocalPath(path)) return null
  const authorizedPath = await authorizedMediaPath(path)
  if (!authorizedPath) return null
  try {
    const bytes = await fs.promises.readFile(authorizedPath)
    if (bytes.byteLength > MAX_MEDIA_BYTES) return null
    const mime = mimeTypeForPath(authorizedPath)
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}





async function authorizedMediaPath(path: string): Promise<string | null> {
  const userData = getUserDataDir()
  try {
    const root = await fs.promises.realpath(userData)
    const candidate = await fs.promises.realpath(resolve(path))
    const remainder = relative(root, candidate)
    if (remainder === '' || remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) return null
    return candidate
  } catch {



    return null
  }
}






export function hasImageExtension(path: string): boolean {
  return extname(path).slice(1).toLowerCase() in MIME_BY_EXT
}

export function hasAudioExtension(path: string): boolean {
  return extname(path).slice(1).toLowerCase() in AUDIO_MIME_BY_EXT
}

export function hasMediaExtension(path: string): boolean {
  const ext = extname(path).slice(1).toLowerCase()
  return ext in MIME_BY_EXT || ext in AUDIO_MIME_BY_EXT
}

export function isAudioFile(path: string): boolean {
  return hasAudioExtension(path)
}
