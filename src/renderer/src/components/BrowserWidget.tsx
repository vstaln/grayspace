import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Lock, RotateCw, Search, X } from 'lucide-react'
import { BROWSER_PARTITION, HOME_URL, hostOf, toNavigationUrl, type Webview } from '../lib/browserShared'

export default React.memo(function BrowserWidget({ widgetId }: { widgetId?: string }): React.JSX.Element {
  const [url, setUrl] = useState(HOME_URL)
  const [address, setAddress] = useState(HOME_URL)
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const viewRef = useRef<Webview | null>(null)
  const [viewEl, setViewEl] = useState<Webview | null>(null)

  useEffect(() => {
    if (!editing) setAddress(url)
  }, [url, editing])

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
      syncHistory()
    }



    const onDomReady = (): void => {
      syncHistory()
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
    view.addEventListener('crashed', onCrashed)
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-finish-load', onDomReady)
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onInPage)
      view.removeEventListener('crashed', onCrashed)
    }
  }, [viewEl])





  useEffect(() => {
    const onDroppedImage = (event: Event): void => {
      const detail = (event as CustomEvent<{ widgetId?: string; path?: string; name?: string }>).detail
      if (!detail?.path || detail.widgetId !== widgetId) return
      void window.api.media.dataUrl(detail.path).then((dataUrl) => {
        if (!dataUrl) {
          setLoadError('Could not load the dropped image')
          return
        }
        setImageSrc(dataUrl)
        setUrl('')
        setAddress(detail.name || 'Dropped image')
        setEditing(false)
        setLoading(true)
        setLoadError(null)
      }).catch((error) => {
        setLoadError(error instanceof Error ? error.message : 'Could not load the dropped image')
        setLoading(false)
      })
    }
    window.addEventListener('orcspace:open-image', onDroppedImage)
    return () => window.removeEventListener('orcspace:open-image', onDroppedImage)
  }, [widgetId])

const host = hostOf(url)
    const isHttps = url.startsWith('https://')
    const navError = !url && address.trim() && (
      'URL must start with http:// or https://'
    )

    return (
      <div className="browser-surface flex h-full min-h-0 flex-col">
        {}
        <div className="browser-chrome flex h-8 flex-none items-center gap-1 px-2">
          <button
            type="button"
            aria-label="Back"
            title="Back"
            disabled={!canGoBack}
            onClick={() => viewRef.current?.goBack()}
            className="browser-icon-btn grid h-6 w-6 flex-none place-items-center rounded-md disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowLeft size={13} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label="Forward"
            title="Forward"
            disabled={!canGoForward}
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
            onSubmit={(e) => {
              e.preventDefault()
              const target = toNavigationUrl(address)
              if (!target) {
                setLoadError('URL must start with http:// or https://')
                return
              }
              setUrl(target)
              setAddress(target)
              setLoading(true)
              setLoadError(null)
              setEditing(false)
              setImageSrc(null)
              void viewRef.current?.loadURL(target).catch(() => {})
            }}
          >
            <div className="pointer-events-none absolute left-2.5 flex items-center text-text-faint">
              {isHttps ? <Lock size={10} strokeWidth={2} /> : <Search size={10} strokeWidth={2} />}
            </div>
            <input
              value={address}
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
                  setAddress(url)
                  e.currentTarget.blur()
                }
              }}
              className="browser-omnibox h-6 w-full rounded-full pl-7 pr-2.5 text-[11px] outline-none placeholder:text-text-faint"
            />
          </form>
          {host && !editing && <span className="mx-1 hidden max-w-[90px] flex-none truncate text-[10px] text-text-faint xl:block">{host}</span>}
          {navError && <span className="text-[10px] text-danger">{navError}</span>}
        </div>
        {loading && (
          <div className="load-bar-track h-px flex-none" aria-hidden>
            <div className="load-bar h-full w-1/3" />
          </div>
        )}
        {!loading && loadError && (
          <div className="flex flex-none items-center justify-between gap-2 border-b border-danger/40 bg-bg-panel px-2 py-1 text-[11px] text-danger">
            <span className="min-w-0 truncate">Error — {loadError}</span>
            <button
              type="button"
              className="flex-none rounded-md bg-bg-raise px-2 py-0.5 text-[10px] text-danger hover:bg-bg-hover"
              onClick={() => viewRef.current?.reload()}
            >
              Retry
            </button>
          </div>
        )}
        <div className="browser-surface relative min-h-0 flex-1">
          <webview
            ref={setViewRef}
            partition={BROWSER_PARTITION}
            allowpopups={'true' as unknown as boolean}
            src={imageSrc ?? HOME_URL}
            className="absolute inset-0 h-full w-full"
          />
        </div>
      </div>
    )
})
