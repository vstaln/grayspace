import type { MediaFile } from '../../../preload/index.d'

/** `![name](C:\...\media\hash.png)` — the link every editor writes for a picture. */
const IMAGE_LINK = /!\[[^\]]*\]\(([^)]+)\)/g

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
  const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'))
  if (file) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const ext = file.name.includes('.') ? file.name.split('.').pop()! : file.type.split('/')[1]
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
  if (Array.from(data.files).some((f) => f.type.startsWith('image/'))) return true
  // A browser image copy exposes an `image/*` item with no File behind it.
  return Array.from(data.items).some((i) => i.kind === 'file' && i.type.startsWith('image/'))
}

/** Absolute paths of every picture referenced by a note body, in order. */
export function imageLinksIn(content: string): string[] {
  return Array.from(String(content || '').matchAll(IMAGE_LINK), (m) => m[1].trim()).filter(Boolean)
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
