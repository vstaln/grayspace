import { IS_WINDOWS } from './platform.ts'










export const BROWSER_PARTITION = 'persist:orcspace-browser'




export const HOME_URL = 'https://www.google.com'



export interface Webview extends HTMLElement {
  src: string
  getWebContentsId(): number
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






// A local path the user typed: `C:\dir\page.html`, `C:/dir/page.html` or a
// UNC share `\\server\share\page.html`. Returned as a normalized file: URL.
function localPathToFileUrl(raw: string): string | null {
  const isDrive = /^[a-zA-Z]:[\\/]/.test(raw)
  const isUnc = /^\\\\[^\\/]/.test(raw)
  // POSIX absolute path, e.g. `/Users/me/page.html`. Windows has no such
  // paths, and there `/docs/index.html` is far likelier to be a search than a
  // file, so the branch only applies where it can actually resolve.
  const isPosix = !IS_WINDOWS && /^\/[^\s]*[/.][^\s]*$/.test(raw)
  if (!isDrive && !isUnc && !isPosix) return null
  try {
    const slashed = raw.replace(/\\/g, '/')
    if (isUnc) return new URL(`file:${slashed}`).href
    return new URL(`file:///${slashed.replace(/^\//, '')}`).href
  } catch {
    return null
  }
}

export function toNavigationUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  const compact = raw.replace(/\s+/g, '').toLowerCase()
  if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')) return null

  // Local files are first-class: `file://…` and bare OS paths both navigate.
  if (/^file:/i.test(raw)) {
    try {
      const parsed = new URL(raw)
      return parsed.protocol === 'file:' ? parsed.href : null
    } catch {
      return null
    }
  }
  const localFile = localPathToFileUrl(raw)
  if (localFile) return localFile

  const candidate = /^https?:\/\//i.test(raw)
    ? raw
    : /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(raw)
      ? `http://${raw}`
      : !/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(raw)
        ? `https://${raw}`
        : null
  if (candidate) {
    try {
      const parsed = new URL(candidate)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
    } catch {
      return null
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}


export function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    // file: URLs have no host; the file name is the useful label instead.
    if (parsed.protocol === 'file:') {
      return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    }
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
