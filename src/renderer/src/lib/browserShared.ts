/**
 * Shared browser surface used by both the full-screen pane (BrowserPane) and
 * the canvas widget (BrowserWidget). Kept in its own module so the pane can be
 * React.lazy-split without dragging it — and everything it imports — back into
 * the startup chunk through BrowserWidget's static import.
 */

/**
 * Session shared by every tab. Must match `BROWSER_PARTITION` in main, which
 * pins it again at attach time — the attribute here is only the hint.
 */
export const BROWSER_PARTITION = 'persist:orcspace-browser'

/**
 * Plain google.com — no `/ncr`.
 *
 * `/ncr` means "no country redirect": it pins every user to the generic
 * google.com experience instead of letting Google send them to their own
 * country's service. That was added to stop the build machine's country
 * appearing in the footer, but it solved that by making the browser wrong for
 * everyone else — a user in any other country got US-style results, language
 * and currency, and no way to correct it.
 *
 * Without it Google resolves the country from the visitor's own IP address on
 * their own machine, which is what makes search results, units and prices come
 * back in the local currency wherever the app is actually installed.
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
}

/**
 * What the user typed, resolved the way an address bar is expected to: a real
 * URL is opened, a bare host is completed to https, and anything else is a
 * Google search rather than a failed navigation.
 */
export function toNavigationUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^localhost(:\d+)?([/?#]|$)/i.test(raw)) return `http://${raw}`
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
