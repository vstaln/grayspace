import type { MediaFile } from '../../../preload/index.d'











export async function saveImageFromPaste(
  event: ClipboardEvent,






  options?: { scratch?: boolean }
): Promise<MediaFile | null> {
  const scratch = options?.scratch === true
  const file = Array.from(event.clipboardData?.files ?? []).find(
    (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i.test(f.name)
  )
  if (file) {
    const f = file as File

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


export function pasteHasImage(event: ClipboardEvent): boolean {
  const data = event.clipboardData
  if (!data) return false
  if (
    Array.from(data.files).some(
      (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i.test(f.name)
    )
  )
    return true

  if (Array.from(data.items).some((i: DataTransferItem) => i.kind === 'file' && i.type.startsWith('image/'))) return true





  if (data.types.includes('text/html')) {
    return /<img\b/i.test(data.getData('text/html'))
  }
  return false
}


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
