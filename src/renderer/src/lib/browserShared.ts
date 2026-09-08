








export const BROWSER_PARTITION = 'persist:orcspace-browser'




export const HOME_URL = 'https://www.google.com'



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






export function toNavigationUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  const compact = raw.replace(/\s+/g, '').toLowerCase()
  if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:') || compact.startsWith('file:')) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(raw)) return `http://${raw}`
  if (!/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(raw)) return `https://${raw}`
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}


export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
