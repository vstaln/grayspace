import type { BrowserWindow } from 'electron'
import { saveBytes, type MediaFile } from './media.ts'

/**
 * A PNG of the canvas, or of one widget on it, saved into the media store.
 *
 * This is the way an image travels *out* of the app: `orc screenshot` hands
 * back a path an agent can read, so a coordinator can look at what a worker's
 * terminal or browser widget is actually showing instead of guessing from
 * scrollback.
 */
export async function captureScreen(
  win: BrowserWindow | null,
  widgetId?: string
): Promise<MediaFile | { error: string }> {
  if (!win || win.isDestroyed()) return { error: 'the OrcSpace window is not open' }
  const contents = win.webContents
  let rect: { x: number; y: number; width: number; height: number } | undefined

  if (widgetId) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(widgetId)) return { error: `invalid widget id "${widgetId}"` }
    const selector = `[data-widget-id=${JSON.stringify(widgetId)}]`
    let raw: { x: number; y: number; width: number; height: number } | null = null
    try {
      raw = await contents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;` +
          ' const r = el.getBoundingClientRect();' +
          ' return { x: r.x, y: r.y, width: r.width, height: r.height } })()'
      )
    } catch (err) {
      return { error: `could not measure ${widgetId}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!raw) return { error: `widget ${widgetId} is not on the canvas` }


    const [contentWidth, contentHeight] = win.getContentSize()
    const x = Math.min(Math.max(Math.floor(raw.x), 0), Math.max(contentWidth - 1, 0))
    const y = Math.min(Math.max(Math.floor(raw.y), 0), Math.max(contentHeight - 1, 0))
    const width = Math.min(Math.ceil(raw.x + raw.width) - x, contentWidth - x)
    const height = Math.min(Math.ceil(raw.y + raw.height) - y, contentHeight - y)
    if (width < 1 || height < 1) {
      return { error: `widget ${widgetId} is scrolled off screen — pan to it first (orc canvas focus)` }
    }
    rect = { x, y, width, height }
  }

  try {
    const image = await (rect ? contents.capturePage(rect) : contents.capturePage())
    if (image.isEmpty()) return { error: 'the capture came back empty' }
    return saveBytes(image.toPNG(), 'png')
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
