import * as electron from 'electron'
import { createHash } from 'crypto'

const clipboard = (electron as unknown as { clipboard?: typeof electron.clipboard }).clipboard
import * as fs from 'fs'
import * as os from 'os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getUserDataDir } from './userData.ts'

/** A picture that now lives in the app's own store, addressable by absolute path. */
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
  // SVG deliberately omitted: a data:image/svg+xml URL can carry inline script
  // and runs with the page origin when used as <img> src in some contexts.
}

export const IMAGE_EXTENSIONS = Object.keys(MIME_BY_EXT)

/** Refuse anything big enough to make a data URL a memory problem in the renderer. */
export const MAX_MEDIA_BYTES = 24 * 1024 * 1024

/**
 * Pasted pictures outlive the note that references them, so they cannot go to
 * the temp dir the way clipboard-to-terminal paths do (see
 * saveClipboardImageToScratch) — they live in userData.
 */
export function mediaDir(): string {
  return join(getUserDataDir(), 'media')
}

/**
 * Content-addressed: pasting the same screenshot into five notes stores one
 * file, and re-pasting after a restart resolves to the copy already on disk.
 */
export function saveBytes(bytes: Buffer, ext: string): MediaFile {
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  const safeExt = MIME_BY_EXT[ext.replace(/^\./, '').toLowerCase()] ? ext.replace(/^\./, '').toLowerCase() : 'png'
  const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  const dir = mediaDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = `${digest}.${safeExt}`
  const path = join(dir, name)
  // An existing file with this name has identical content by construction.
  if (!fs.existsSync(path)) fs.writeFileSync(path, bytes)
  return { name, path }
}

/** Copies a picture the user already has on disk into the store. */
export function importFile(source: string): MediaFile {
  if (!isLocalPath(source)) throw new Error('UNC and remote paths are not allowed')
  const bytes = fs.readFileSync(source)
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  return saveBytes(bytes, extname(source))
}

/** The clipboard's bitmap, or null when it holds no image at all. */
export function saveClipboardImage(): MediaFile | null {
  if (!clipboard) return null
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const bytes = image.toPNG()
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  return saveBytes(bytes, 'png')
}

/** Where throwaway clipboard pictures land, outside the app's own storage. */
export function scratchDir(): string {
  return join(os.tmpdir(), 'orcspace-clipboard')
}

/** saveBytes' throwaway twin — same content addressing, temp dir instead. */
export function saveBytesToScratch(bytes: Buffer, ext: string): MediaFile {
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  const safeExt = MIME_BY_EXT[ext.replace(/^\./, '').toLowerCase()] ? ext.replace(/^\./, '').toLowerCase() : 'png'
  const dir = scratchDir()
  fs.mkdirSync(dir, { recursive: true })
  const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
  const name = `${digest}.${safeExt}`
  const path = join(dir, name)
  if (!fs.existsSync(path)) fs.writeFileSync(path, bytes)
  return { name, path }
}

/**
 * Clipboard bitmap written to the OS temp dir instead of the app's media store.
 *
 * A picture pasted into a *terminal* is not content the app owns — it becomes
 * an argument to some CLI and stops mattering the moment that command is done.
 * Routing it through saveBytes() put every such screenshot in userData/media
 * permanently, where nothing ever collects it and the app's own storage grows
 * without bound. The temp dir is the right home: the OS reclaims it, and the
 * path stays valid for as long as the command needs to read it.
 *
 * Notes are the opposite case and keep using saveBytes() — a note outlives the
 * paste and must still resolve its picture after a restart.
 */
export function saveClipboardImageToScratch(): MediaFile | null {
  if (!clipboard) return null
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const bytes = image.toPNG()
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('File larger than 24 MB')
  // Content-addressed like the durable store, so pasting the same screenshot
  // twice reuses one file rather than filling the temp dir with copies.
  return saveBytesToScratch(bytes, 'png')
}

/**
 * Rejects anything that isn't a plain local drive path: a UNC path
 * (`\\host\share\x.png`) or a `//host/share` path makes Windows open an SMB
 * connection to `host` just to read the "file", which leaks the current
 * user's NTLM hash to whoever controls that host — the same bug class as the
 * old Outlook/Office UNC-image CVEs. Note content can carry a path an agent
 * wrote, and NoteAttachments resolves every linked image the moment a note is
 * opened, with no click involved, so this has to be enforced here rather than
 * trusted to callers.
 */
export function isLocalPath(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) return false
  return isAbsolute(path)
}

/**
 * The renderer runs on http:// in dev, where `file://` images are blocked, so
 * pictures cross the bridge as data URLs rather than paths.
 *
 * Reading is restricted to the app's own data directory (media store +
 * wallpapers) — a note body can carry any path an agent wrote, and
 * NoteAttachments resolves every linked image on open with no click, so a
 * hand-typed path into, say, a private screenshot must not turn this into a
 * read-any-image bridge (SEC-006). Combined with the extension check at the
 * IPC layer, only app-authored images are readable.
 *
 * Reads asynchronously on purpose: this runs in the main process, where a
 * synchronous read stalls every window and all IPC for as long as the
 * filesystem call takes — including a network path hanging on a dead host.
 */
export async function dataUrl(path: string): Promise<string | null> {
  if (!isLocalPath(path)) return null
  const authorizedPath = await authorizedMediaPath(path)
  if (!authorizedPath) return null
  try {
    const bytes = await fs.promises.readFile(authorizedPath)
    if (bytes.byteLength > MAX_MEDIA_BYTES) return null
    const mime = MIME_BY_EXT[extname(authorizedPath).slice(1).toLowerCase()] || 'image/png'
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * True for anything under the app's profile dir (media store, wallpapers) —
 * the only places this app itself ever writes pictures.
 */
async function authorizedMediaPath(path: string): Promise<string | null> {
  const userData = getUserDataDir()
  try {
    const root = await fs.promises.realpath(userData)
    const candidate = await fs.promises.realpath(resolve(path))
    const remainder = relative(root, candidate)
    if (remainder === '' || remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) return null
    return candidate
  } catch {
    // Missing files and broken links are not authorized reads. In particular,
    // do not fall back to a lexical prefix check: `userData\\..\\secret.png`
    // and symlinks must never escape the profile directory.
    return null
  }
}

/**
 * Notes can reference pictures outside the store (a path an agent wrote, a file
 * the user linked by hand), but `media:data-url` only reads inside userData —
 * this extension gate is the second layer, not the only one (SEC-006).
 */
export function hasImageExtension(path: string): boolean {
  return extname(path).slice(1).toLowerCase() in MIME_BY_EXT
}
