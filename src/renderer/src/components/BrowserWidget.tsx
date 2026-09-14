import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, FileText, Lock, RotateCw, Search, X } from 'lucide-react'
import { BROWSER_PARTITION, HOME_URL, hostOf, toNavigationUrl, type Webview } from '../lib/browserShared'
import { WIDGET_FULLSCREEN_SCRIPT } from '../lib/widgetFullscreen'

export type DroppedMediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'doc'

interface DroppedMedia {
  mediaUrl: string
  path: string
  name: string
  kind: DroppedMediaKind
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic'])
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'ogv', 'mpg', 'mpeg'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'weba', 'wma'])
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'log', 'js', 'ts', 'jsx', 'tsx', 'py', 'sh', 'bat', 'cmd', 'ps1'])

export function mediaKindForName(name: string, fallback?: string): DroppedMediaKind {
  if (fallback === 'image' || fallback === 'video' || fallback === 'audio' || fallback === 'pdf' || fallback === 'text' || fallback === 'doc') {
    return fallback
  }
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'doc'
}

function readMedia(widgetId: string | undefined): DroppedMedia | null {
  if (!widgetId) return null
  try {
    const raw = localStorage.getItem(`orcspace-browser-media:${widgetId}`)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<DroppedMedia>
    if (typeof v.mediaUrl !== 'string' || typeof v.path !== 'string' || typeof v.name !== 'string') return null
    if (v.mediaUrl.startsWith('data:')) return null
    return { mediaUrl: v.mediaUrl, path: v.path, name: v.name, kind: mediaKindForName(v.name, v.kind) }
  } catch {
    return null
  }
}

function readUrl(widgetId: string | undefined): string {
  if (!widgetId) return HOME_URL
  try {
    const raw = localStorage.getItem(`orcspace-browser-url:${widgetId}`)
    if (raw && (raw.startsWith('http://') || raw.startsWith('https://'))) return raw
  } catch {}
  return HOME_URL
}

export default React.memo(function BrowserWidget({ widgetId }: { widgetId?: string }): React.JSX.Element {
  const [url, setUrl] = useState(() => readUrl(widgetId))
  const [address, setAddress] = useState(() => readUrl(widgetId))
  const [media, setMedia] = useState<DroppedMedia | null>(() => readMedia(widgetId))
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const viewRef = useRef<Webview | null>(null)
  const [viewEl, setViewEl] = useState<Webview | null>(null)
  const retryCountRef = useRef(0)
  const [initialUrl] = useState(url)

  useEffect(() => {
    if (!editing && !media) setAddress(url)
  }, [url, editing, media])

  useEffect(() => {
    if (!widgetId || media) return
    try {
      localStorage.setItem(`orcspace-browser-url:${widgetId}`, url)
    } catch {}
  }, [url, media, widgetId])

  // Persist dropped media per widget so video/audio/docs survive restart.
  // data: URLs are never persisted (quota + OOM): only orc://media/ entries.
  useEffect(() => {
    if (!widgetId) return
    try {
      if (media && media.mediaUrl.startsWith('orc://media/')) {
        localStorage.setItem(`orcspace-browser-media:${widgetId}`, JSON.stringify(media))
      } else if (media) {
        localStorage.removeItem(`orcspace-browser-media:${widgetId}`)
      } else {
        localStorage.removeItem(`orcspace-browser-media:${widgetId}`)
      }
    } catch {}
  }, [media, widgetId])

  const setViewRef = useCallback((el: HTMLElement | null): void => {
    const w = el ? (el as unknown as Webview) : null
    viewRef.current = w
    setViewEl(w)
  }, [])

  useLayoutEffect(() => {
    const view = viewEl
    if (!view) return undefined

    const syncHistory = (): void => {
      try {
        setCanGoBack(view.canGoBack())
        setCanGoForward(view.canGoForward())
      } catch {}
    }
    const onStart = (): void => {
      setLoading(true)
      setLoadError(null)
    }
    const onStop = (): void => {
      setLoading(false)
      retryCountRef.current = 0
      syncHistory()
    }



    const onDomReady = (): void => {
      syncHistory()
      void view.executeJavaScript(WIDGET_FULLSCREEN_SCRIPT, true).catch(() => {})
    }
    const onFail = (event: Event): void => {
      const e = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (e.errorCode === -3 || e.isMainFrame === false) return
      setLoading(false)
      setLoadError(e.errorDescription || 'server unreachable')
      syncHistory()
    }
    const onNavigate = (event: Event): void => {
      const navUrl = (event as Event & { url?: string }).url


      if (navUrl && !navUrl.startsWith('data:')) setUrl(navUrl)
      syncHistory()
    }
    const onInPage = (event: Event): void => {
      const e = event as Event & { url?: string; isMainFrame?: boolean }
      if (e.isMainFrame && e.url && !e.url.startsWith('data:')) setUrl(e.url)
      syncHistory()
    }
    const onEnterHtmlFullscreen = (event: Event): void => {
      // A webview fullscreen request must stay inside this widget, never promote the app window.
      event.preventDefault()
    }
    let crashReloads = 0
    const onCrashed = (): void => {
      setLoading(false)
      if (crashReloads < 1) {
        crashReloads += 1
        try {
          view.reload()
        } catch {}
      } else {
        setLoadError('The web page process crashed. Click retry or enter a new URL.')
      }
    }

    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-finish-load', onDomReady)
    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onInPage)
    view.addEventListener('enter-html-full-screen', onEnterHtmlFullscreen)
    view.addEventListener('crashed', onCrashed)
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-finish-load', onDomReady)
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onInPage)
      view.removeEventListener('enter-html-full-screen', onEnterHtmlFullscreen)
      view.removeEventListener('crashed', onCrashed)
    }
  }, [viewEl])




  useEffect(() => {
    const onDroppedMedia = (event: Event): void => {
      const detail = (event as CustomEvent<{ widgetId?: string; path?: string; name?: string; mediaUrl?: string; kind?: string }>).detail
      if (!detail?.path || detail.widgetId !== widgetId) return
      const open = (mediaUrl: string): void => {
        const ok =
          mediaUrl.startsWith('orc://media/') ||
          mediaUrl.startsWith('data:image/') ||
          mediaUrl.startsWith('data:audio/') ||
          mediaUrl.startsWith('data:video/') ||
          mediaUrl.startsWith('data:application/pdf')
        if (!ok) {
          setLoadError('Could not load the dropped media')
          setLoading(false)
          return
        }
        setMedia({ mediaUrl, path: detail.path!, name: detail.name || 'Dropped file', kind: mediaKindForName(detail.name || detail.path!, detail.kind) })
        setAddress(detail.name || 'Dropped file')
        setEditing(false)
        setLoading(false)
        setLoadError(null)
      }
      if (detail.mediaUrl) {
        open(detail.mediaUrl)
      } else {
        const kind = mediaKindForName(detail.name || detail.path!, detail.kind)
        if (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'pdf') {
          setLoadError('Could not load the dropped media')
          setLoading(false)
          return
        }
        void window.api.media.dataUrl(detail.path).then((dataUrl) => {
          if (!dataUrl) {
            setLoadError('Could not load the dropped media')
            return
          }
          open(dataUrl)
        }).catch((error) => {
          setLoadError(error instanceof Error ? error.message : 'Could not load the dropped media')
          setLoading(false)
        })
      }
    }
    window.addEventListener('orcspace:open-image', onDroppedMedia)
    window.addEventListener('orcspace:open-media', onDroppedMedia)
    return () => {
      window.removeEventListener('orcspace:open-image', onDroppedMedia)
      window.removeEventListener('orcspace:open-media', onDroppedMedia)
    }
  }, [widgetId])

  const closeMedia = useCallback((): void => {
    setMedia(null)
    setLoadError(null)
    setLoading(false)
  }, [])

  const openExternally = useCallback((path: string): void => {
    void window.api.fs.openPath(path).catch(() => {})
  }, [])

  const navigate = useCallback((value: string): void => {
    const target = toNavigationUrl(value)
    if (!target) {
      setLoadError('URL must start with http:// or https://')
      return
    }
    setUrl(target)
    setAddress(target)
    setLoading(true)
    setLoadError(null)
    setEditing(false)
    setMedia(null)
    void viewRef.current?.loadURL(target).catch(() => {})
  }, [])

  const isHome = !media && (() => {
    try {
      const home = new URL(url)
      return home.hostname === 'www.google.com' && home.pathname === '/'
    } catch {
      return false
    }
  })()
  const host = hostOf(url)
    const isHttps = url.startsWith('https://')
    const navError = !url && !media && address.trim() && (
      'URL must start with http:// or https://'
    )

    return (
      <div className="browser-surface flex h-full min-h-0 flex-col">
        <div className="browser-chrome flex h-8 flex-none items-center gap-1 px-2">
          <button
            type="button"
            aria-label="Back"
            title="Back"
            disabled={!canGoBack || !!media}
            onClick={() => viewRef.current?.goBack()}
            className="browser-icon-btn grid h-6 w-6 flex-none place-items-center rounded-md disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowLeft size={13} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label="Forward"
            title="Forward"
            disabled={!canGoForward || !!media}
            onClick={() => viewRef.current?.goForward()}
            className="browser-icon-btn grid h-6 w-6 flex-none place-items-center rounded-md disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowRight size={13} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label={loading ? 'Stop' : 'Reload'}
            title={loading ? 'Stop' : 'Reload'}
            onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
            className="browser-icon-btn grid h-6 w-6 flex-none place-items-center rounded-md"
          >
            {loading ? <X size={13} strokeWidth={1.9} /> : <RotateCw size={12} strokeWidth={1.9} />}
          </button>
          <form
            className="relative ml-1 flex min-w-0 flex-1 items-center"
            onSubmit={(e) => { e.preventDefault(); navigate(address) }}
          >
            <div className="pointer-events-none absolute left-2.5 flex items-center text-text-faint">
              {isHttps ? <Lock size={10} strokeWidth={2} /> : <Search size={10} strokeWidth={2} />}
            </div>
            <input
              value={isHome && (address === HOME_URL || address === `${HOME_URL}/`) ? '' : address}
              spellCheck={false}
              aria-label="Address and search"
              placeholder="Search or enter address"
              onChange={(e) => {
                setEditing(true)
                setAddress(e.target.value)
              }}
              onFocus={(e) => {
                setEditing(true)
                e.target.select()
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditing(false)
                  setAddress(media ? media.name : url)
                  e.currentTarget.blur()
                }
              }}
              className="browser-omnibox h-6 w-full rounded-full pl-7 pr-2.5 text-[11px] outline-none placeholder:text-text-faint"
            />
          </form>
          {host && !editing && !media && <span className="mx-1 hidden max-w-[90px] flex-none truncate text-[10px] text-text-faint xl:block">{host}</span>}
          {media && (
            <button
              type="button"
              onClick={closeMedia}
              title="Back to browser"
              className="flex flex-none items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-text-dim hover:bg-bg-hover hover:text-text"
            >
              <X size={10} /> Browser
            </button>
          )}
          {navError && <span className="text-[10px] text-danger">{navError}</span>}
        </div>
        {loading && !media && !isHome && (
          <div className="load-bar-track h-px flex-none" aria-hidden>
            <div className="load-bar h-full w-1/3" />
          </div>
        )}
        {!loading && loadError && (
          <div role="alert" className="flex flex-none items-center justify-between gap-2 border-b border-danger/40 bg-bg-panel px-2 py-1 text-[11px] text-danger">
            <span className="min-w-0 truncate">Error — {loadError}</span>
            <span className="flex flex-none gap-1">
              {retryCountRef.current < 3 ? (
                <button
                  type="button"
                  className="rounded-md bg-bg-raise px-2 py-0.5 text-[10px] text-danger hover:bg-bg-hover"
                  onClick={() => {
                    retryCountRef.current += 1
                    setLoadError(null)
                    setLoading(true)
                    try {
                      viewRef.current?.reload()
                    } catch {}
                  }}
                >
                  Retry
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-md bg-bg-raise px-2 py-0.5 text-[10px] text-text-dim hover:bg-bg-hover hover:text-text"
                onClick={() => {
                  retryCountRef.current = 0
                  setLoadError(null)
                  setMedia(null)
                  setUrl(HOME_URL)
                  setAddress(HOME_URL)
                  setLoading(true)
                  try {
                    void viewRef.current?.loadURL(HOME_URL)
                  } catch {}
                }}
              >
                Home
              </button>
            </span>
          </div>
        )}
        <div className="browser-surface relative min-h-0 flex-1">
          <webview
            ref={setViewRef}
            partition={BROWSER_PARTITION}
            allowpopups={'true' as unknown as boolean}
            src={initialUrl}
            aria-label="Browser"
            className="absolute inset-0 h-full w-full"
            style={media || isHome ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
          />
          {media && (
            <MediaViewer media={media} onClose={closeMedia} onOpenExternally={openExternally} />
          )}
        </div>
      </div>
    )
})

function MediaViewer({ media, onClose, onOpenExternally }: { media: DroppedMedia; onClose(): void; onOpenExternally(path: string): void }): React.JSX.Element {
  if (media.kind === 'image') {
    return (
      <div className="absolute inset-0 grid place-items-center overflow-auto bg-bg p-2">
        <img src={media.mediaUrl} alt={media.name} className="max-h-full max-w-full rounded object-contain" />
      </div>
    )
  }
  if (media.kind === 'video') {
    return (
      <div className="absolute inset-0 flex flex-col bg-bg">
        <div className="flex flex-none items-center justify-between gap-2 border-b border-line-soft px-2 py-1 text-[10px] text-text-faint">
          <span className="min-w-0 truncate" title={media.name}>{media.name}</span>
          <button type="button" onClick={onClose} className="flex-none rounded px-1.5 py-0.5 hover:bg-bg-hover hover:text-text">Close</button>
        </div>
        <video key={media.mediaUrl} src={media.mediaUrl} controls preload="metadata" className="min-h-0 w-full flex-1 bg-black" />
      </div>
    )
  }
  if (media.kind === 'audio') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg p-4 text-center">
        <div className="max-w-full truncate text-[12px] font-medium text-text" title={media.name}>{media.name}</div>
        <audio key={media.mediaUrl} src={media.mediaUrl} controls preload="metadata" className="w-full max-w-[320px]" />
      </div>
    )
  }
  if (media.kind === 'pdf') {
    return (
      <div className="absolute inset-0 flex flex-col bg-bg">
        <div className="flex flex-none items-center justify-between gap-2 border-b border-line-soft px-2 py-1 text-[10px] text-text-faint">
          <span className="min-w-0 truncate" title={media.name}>{media.name}</span>
          <button type="button" onClick={onClose} className="flex-none rounded px-1.5 py-0.5 hover:bg-bg-hover hover:text-text">Close</button>
        </div>
        <embed key={media.mediaUrl} src={media.mediaUrl} type="application/pdf" className="min-h-0 w-full flex-1 border-0 bg-bg" />
      </div>
    )
  }
  if (media.kind === 'text') {
    return (
      <div className="absolute inset-0 flex flex-col bg-bg">
        <div className="flex flex-none items-center justify-between gap-2 border-b border-line-soft px-2 py-1 text-[10px] text-text-faint">
          <span className="min-w-0 truncate" title={media.name}>{media.name}</span>
          <button type="button" onClick={onClose} className="flex-none rounded px-1.5 py-0.5 hover:bg-bg-hover hover:text-text">Close</button>
        </div>
        <iframe key={media.mediaUrl} src={media.mediaUrl} title={media.name} sandbox="" className="min-h-0 w-full flex-1 border-0 bg-bg" />
      </div>
    )
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg p-4 text-center">
      <FileText size={22} className="text-text-faint" />
      <div className="max-w-full truncate text-[12px] font-medium text-text" title={media.name}>{media.name}</div>
      <div className="max-w-full truncate text-[10px] text-text-faint" title={media.path}>{media.path}</div>
      <div className="mt-1 flex gap-1.5">
        <button
          type="button"
          onClick={() => onOpenExternally(media.path)}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-bg hover:opacity-90"
        >
          Open
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line px-2.5 py-1 text-[11px] text-text-dim hover:bg-bg-hover hover:text-text"
        >
          Back
        </button>
      </div>
    </div>
  )
}
