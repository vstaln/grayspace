import * as electron from 'electron'
import { createHash } from 'crypto'

const clipboard = (electron as unknown as { clipboard?: typeof electron.clipboard }).clipboard
const nativeImage = (electron as unknown as { nativeImage?: typeof electron.nativeImage }).nativeImage
import * as fs from 'fs'
import * as os from 'os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'
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
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic'
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
  weba: 'audio/webm',
  wma: 'audio/x-ms-wma'
}

export const AUDIO_EXTENSIONS = Object.keys(AUDIO_MIME_BY_EXT)

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg'
}

export const VIDEO_EXTENSIONS = Object.keys(VIDEO_MIME_BY_EXT)

const DOC_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  log: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  js: 'text/javascript',
  ts: 'text/typescript',
  jsx: 'text/javascript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  sh: 'text/x-sh',
  bat: 'text/plain',
  cmd: 'text/plain',
  ps1: 'text/plain'
}

export const DOC_EXTENSIONS = Object.keys(DOC_MIME_BY_EXT)

export const MEDIA_MIME_BY_EXT: Record<string, string> = {
  ...MIME_BY_EXT,
  ...AUDIO_MIME_BY_EXT,
  ...VIDEO_MIME_BY_EXT,
  ...DOC_MIME_BY_EXT
}


export const MAX_MEDIA_BYTES = 256 * 1024 * 1024


export function mimeTypeForPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase()
  return MEDIA_MIME_BY_EXT[ext] || 'application/octet-stream'
}






export function mediaDir(): string {
  return join(getUserDataDir(), 'media')
}





export function saveBytes(bytes: Buffer, ext: string): MediaFile {
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
  const clean = ext.replace(/^\./, '').toLowerCase()
  const safeExt = /^[a-z0-9_-]{1,16}$/i.test(clean) ? clean : 'bin'
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
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
  return saveBytes(bytes, extname(source))
}


export function saveClipboardImage(): MediaFile | null {
  if (!clipboard) return null
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const bytes = image.toPNG()
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
  return saveBytes(bytes, 'png')
}

export function readClipboardText(): string {
  try {
    return clipboard?.readText() ?? ''
  } catch {
    return ''
  }
}

export function stageClipboardImage(bytes: Buffer): { ok: true } | { error: string } {
  if (!clipboard || !nativeImage) return { error: 'Clipboard image support is unavailable' }
  if (!bytes.byteLength) return { error: 'Image is empty' }
  if (bytes.byteLength > MAX_MEDIA_BYTES) return { error: 'Image exceeds 256 MB' }

  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return { error: 'Unsupported image format' }
  clipboard.writeImage(image)
  return { ok: true }
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
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
  const clean = ext.replace(/^\./, '').toLowerCase()
  const safeExt = /^[a-z0-9_-]{1,16}$/i.test(clean) ? clean : 'bin'
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
  if (!image.isEmpty()) {
    const bytes = image.toPNG()
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
    return saveBytesToScratch(bytes, 'png')
  }

  try {
    const text = clipboard.readText().trim()
    if (
      text &&
      /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i.test(text) &&
      fs.existsSync(text) &&
      fs.statSync(text).isFile()
    ) {
      return { name: basename(text), path: text }
    }
  } catch {
    /* ignore clipboard text read errors */
  }

  return null
}









export function isLocalPath(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) return false
  return isAbsolute(path)
}















export const MAX_DATA_URL_BYTES = 8 * 1024 * 1024

export async function dataUrl(path: string): Promise<string | null> {
  if (!isLocalPath(path)) return null
  const authorizedPath = await authorizedMediaPath(path)
  if (!authorizedPath) return null
  try {
    const stat = await fs.promises.stat(authorizedPath)
    if (!stat.isFile() || stat.size > MAX_DATA_URL_BYTES) return null
    const bytes = await fs.promises.readFile(authorizedPath)
    if (bytes.byteLength > MAX_DATA_URL_BYTES) return null
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

export function hasVideoExtension(path: string): boolean {
  return extname(path).slice(1).toLowerCase() in VIDEO_MIME_BY_EXT
}

export function hasDocExtension(path: string): boolean {
  return extname(path).slice(1).toLowerCase() in DOC_MIME_BY_EXT
}

export function hasMediaExtension(path: string): boolean {
  const ext = extname(path).slice(1).toLowerCase()
  return ext in MEDIA_MIME_BY_EXT
}

export function isAudioFile(path: string): boolean {
  return hasAudioExtension(path)
}
