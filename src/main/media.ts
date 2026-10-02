import * as electron from 'electron'
import { createHash, randomBytes } from 'crypto'

const clipboard = (electron as unknown as { clipboard?: typeof electron.clipboard }).clipboard
const ClipboardItem = (electron as unknown as { ClipboardItem?: typeof electron.ClipboardItem }).ClipboardItem
import * as fs from 'fs'
import * as os from 'os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
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
  const digest = createHash('sha256').update(bytes).digest('hex')
  const dir = mediaDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = `${digest}.${safeExt}`
  const path = join(dir, name)

  writeBytesIfMissing(path, bytes)
  return { name, path }
}


export function importFile(source: string): MediaFile {
  if (!isLocalPath(source)) throw new Error('UNC and remote paths are not allowed')
  const stat = fs.statSync(source)
  if (!stat.isFile()) throw new Error('File must be a regular file')
  if (stat.size > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
  const bytes = fs.readFileSync(source)
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
  return saveBytes(bytes, extname(source))
}

/** Publish content-addressed media as a complete file, including under concurrent pastes. */
function writeBytesIfMissing(path: string, bytes: Buffer): void {
  if (fs.existsSync(path)) return
  const directory = dirname(path)
  const temporary = join(directory, `.${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    try {
      fs.renameSync(temporary, path)
    } catch (error) {
      if (fs.existsSync(path)) {
        fs.rmSync(temporary, { force: true })
        return
      }
      throw error
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { }
    }
    try { fs.rmSync(temporary, { force: true }) } catch { }
    throw error
  }
}


export async function saveClipboardImage(): Promise<MediaFile | null> {
  if (!clipboard) return null
  const items = await clipboard.read()
  const item = items.find((candidate) => candidate.types.some((type) => type.startsWith('image/')))
  if (!item) return null
  const imageType = item.types.find((type) => type.startsWith('image/'))
  if (!imageType) return null
  const payload = await item.getType(imageType) as Blob
  const bytes = Buffer.from(await payload.arrayBuffer())
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File exceeds 256 MB limit')
  return saveBytes(bytes, 'png')
}

export async function readClipboardText(): Promise<string> {
  try {
    return clipboard ? await clipboard.readText() : ''
  } catch {
    return ''
  }
}

export async function writeClipboardText(text: string): Promise<{ ok: true } | { error: string }> {
  if (!clipboard) return { error: 'Clipboard support is unavailable' }
  if (typeof text !== 'string' || text.length > 4096) return { error: 'Invalid clipboard text' }
  try {
    await clipboard.writeText(text)
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function stageClipboardImage(bytes: Buffer): Promise<{ ok: true } | { error: string }> {
  if (!clipboard || !ClipboardItem) return { error: 'Clipboard image support is unavailable' }
  if (!bytes.byteLength) return { error: 'Image is empty' }
  if (bytes.byteLength > MAX_MEDIA_BYTES) return { error: 'Image exceeds 256 MB' }

  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })])
    return { ok: true }
  } catch {
    return { error: 'Unsupported image format' }
  }
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
  const digest = createHash('sha256').update(bytes).digest('hex')
  const name = `${digest}.${safeExt}`
  const path = join(dir, name)
  if (fs.existsSync(path)) {
    // The name is the content hash, so pasting the same image twice reuses
    // the first file and skips the write — which also left its mtime at the
    // original save. pruneScratch() ages files out by mtime, so a path handed
    // out just now could be deleted by the very next paste if the bytes
    // happened to be old enough, and the agent that was given the path found
    // nothing there. Reuse means "wanted again": restart its lifetime.
    try {
      const now = new Date()
      fs.utimesSync(path, now, now)
    } catch {

    }
  } else {
    writeBytesIfMissing(path, bytes)
  }
  return { name, path }
}












export async function saveClipboardImageToScratch(): Promise<MediaFile | null> {
  if (!clipboard) return null
  const items = await clipboard.read()
  const item = items.find((candidate) => candidate.types.some((type) => type.startsWith('image/')))
  const imageType = item?.types.find((type) => type.startsWith('image/'))
  if (item && imageType) {
    const payload = await item.getType(imageType) as Blob
    const bytes = Buffer.from(await payload.arrayBuffer())
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

/**
 * Lexical containment: is `candidate` the root itself or below it?
 * Caller must pass absolute, normalized paths. Case-insensitive on
 * win32/darwin to match the filesystem.
 */
export function isPathWithinRoot(candidateAbs: string, rootAbs: string): boolean {
  const norm = (p: string): string => {
    let out = resolve(p)
    if (process.platform === 'win32' || process.platform === 'darwin') out = out.toLowerCase()
    return out
  }
  const candidate = norm(candidateAbs)
  const root = norm(rootAbs)
  if (candidate === root) return true
  const rel = relative(root, candidate)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  return true
}

function realpathOfExisting(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Resolve `input` against the workspace jail.
 * Returns the canonical absolute path when it is inside `workspaceDir`,
 * otherwise null (deny-by-default: missing workspace, non-local path,
 * or containment failure all deny).
 *
 * Symlinks are resolved via realpath. For paths that do not exist yet
 * (create/mkdir/write-new) the nearest existing ancestor is resolved and
 * the remainder re-appended before the containment check, so
 * `<workspace>/new-file` passes but `<workspace>/link-to-etc/passwd`
 * (where `link-to-etc` points outside) is denied.
 */
export function resolveInWorkspaceSync(input: string, workspaceDir: string | undefined | null): string | null {
  if (typeof input !== 'string' || !input.trim()) return null
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) return null
  const raw = input.trim()
  if (!isLocalPath(raw)) return null
  if (!isLocalPath(workspaceDir.trim())) return null
  let rootReal: string
  try {
    rootReal = fs.realpathSync(resolve(workspaceDir.trim()))
  } catch {
    return null
  }
  const abs = resolve(raw)
  const direct = realpathOfExisting(abs)
  if (direct) {
    return isPathWithinRoot(direct, rootReal) ? direct : null
  }
  // Walk up to the nearest existing ancestor (handles new files).
  let cursor = abs
  const parts: string[] = []
  for (;;) {
    const parent = dirname(cursor)
    if (parent === cursor) return null
    parts.unshift(cursor.slice(parent.length).replace(/^[/\\]+/, ''))
    cursor = parent
    const parentReal = realpathOfExisting(cursor)
    if (parentReal) {
      const canonical = join(parentReal, ...parts)
      return isPathWithinRoot(canonical, rootReal) ? canonical : null
    }
    if (cursor === resolve(workspaceDir.trim()) || cursor.length < 3) {
      // Fell past the workspace without hitting an existing dir: deny.
      // (Prevents `C:\nope\..\workspace`-style lexically-inside but
      // unresolvable games from being trusted.)
      const fallback = join(rootReal, ...parts)
      void fallback
      return null
    }
  }
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
  let userData: string | null = null
  try {
    userData = getUserDataDir()
  } catch {
    userData = null
  }
  const scratch = scratchDir()
  try {
    const candidate = await fs.promises.realpath(resolve(path))
    const rootUser = userData ? await fs.promises.realpath(userData).catch(() => resolve(userData!)) : null
    const rootScratch = await fs.promises.realpath(scratch).catch(() => resolve(scratch))
    if (
      (rootUser && isPathWithinRoot(candidate, rootUser) && candidate.toLowerCase() !== rootUser.toLowerCase()) ||
      (isPathWithinRoot(candidate, rootScratch) && candidate.toLowerCase() !== rootScratch.toLowerCase())
    ) {
      return candidate
    }
    return null
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
