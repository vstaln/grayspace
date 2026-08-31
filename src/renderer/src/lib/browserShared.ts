/**
 * Shared browser surface used by both the full-screen pane (BrowserPane) and
 * the canvas widget (BrowserWidget). Kept in its own module so the pane can be
 * React.lazy-split without dragging it into the startup chunk.
 */

/**
 * Session shared by every tab.
 */
export const BROWSER_PARTITION = 'persist:orcspace-browser'

/**
 * Default home URL (standard Google search).
 */
export const HOME_URL = 'https://www.google.com'

/** Only the slice of Electron's WebviewTag this app drives, so the renderer
 *  build never needs Electron's own type surface. */
export interface Webview extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  insertCSS?(css: string): Promise<string>
}

/**
 * What the user typed, resolved the way an address bar is expected to: a real
 * URL is opened, a bare host is completed to https, and anything else is a
 * search query.
 */
export function toNavigationUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  // Block dangerous protocols immediately
  const compact = raw.replace(/\s+/g, '').toLowerCase()
  if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:') || compact.startsWith('file:')) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(raw)) return `http://${raw}`
  if (!/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(raw)) return `https://${raw}`
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}

/** Host without `www.`, used for the tab's letter badge and its fallback label. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
