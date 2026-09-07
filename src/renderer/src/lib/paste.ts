import type { MediaFile } from '../../../preload/index.d'

/**
 * Pulls the picture out of a paste, whichever way the OS offered it, and copies
 * it into the app's media store.
 *
 * Two paths matter and neither covers the other: screenshots and files dragged
 * from a file manager arrive as `clipboardData.files`, while an image copied
 * from a browser often reaches Electron only through the native clipboard, with
 * `clipboardData` carrying nothing but an HTML fragment. Returns null when the
 * paste held no picture at all, so callers can fall through to plain text.
 */
export async function saveImageFromPaste(
  event: ClipboardEvent,
  /**
   * `scratch` writes to the OS temp dir instead of the app's durable media
   * store. Terminals pass it: the picture there is only ever a path handed to
   * a command, so keeping it forever in userData just grows the app's storage
   * with files nothing will ever read again.
   */
  options?: { scratch?: boolean }
): Promise<MediaFile | null> {
  const scratch = options?.scratch === true
  const file = Array.from(event.clipboardData?.files ?? []).find(
    (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i.test(f.name)
  )
  if (file) {
    const f = file as File
    // DoS guard: clipboard image >20 MB would OOM renderer (arrayBuffer dup)
    if (f.size > 20 * 1024 * 1024) {
      console.warn('paste image too large', f.size)
      return null
    }
    const bytes = new Uint8Array(await f.arrayBuffer())
    const ext = f.name.includes('.') ? f.name.split('.').pop()! : f.type.split('/')[1] || 'png'
    const saved = scratch
      ? await window.api.media.saveBytesScratch(bytes, ext)
      : await window.api.media.saveBytes(bytes, ext)
    if (saved && 'path' in saved) return saved
    return null
  }
  return scratch ? window.api.media.saveClipboardScratch() : window.api.media.saveClipboard()
}

/** True when the paste carries a picture, so the caller should not treat it as text. */
export function pasteHasImage(event: ClipboardEvent): boolean {
  const data = event.clipboardData
  if (!data) return false
  if (
    Array.from(data.files).some(
      (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i.test(f.name)
    )
  )
    return true
  // A browser image copy exposes an `image/*` item with no File behind it.
  if (Array.from(data.items).some((i: DataTransferItem) => i.kind === 'file' && i.type.startsWith('image/'))) return true

  // Some Chromium/Electron clipboard providers expose a copied image as rich
  // HTML plus an alt label in text/plain (for example, "Image One"). Treat
  // the HTML image as the source of truth so the caller does not paste that
  // label into the CLI prompt instead of forwarding the image shortcut.
  if (data.types.includes('text/html')) {
    return /<img\b/i.test(data.getData('text/html'))
  }
  return false
}

/** Splices `text` into `value` at the cursor, returning the new value and caret. */
export function insertAt(
  value: string,
  start: number,
  end: number,
  text: string
): { value: string; caret: number } {
  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + text.length
  }
}
