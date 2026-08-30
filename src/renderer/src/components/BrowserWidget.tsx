import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Lock, RotateCw, Search, X } from 'lucide-react'
import { BROWSER_PARTITION, HOME_URL, hostOf, toNavigationUrl, type Webview } from '../lib/browserShared'

export default React.memo(function BrowserWidget(): React.JSX.Element {
  const [url, setUrl] = useState(HOME_URL)
  const [address, setAddress] = useState(HOME_URL)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const viewRef = useRef<Webview | null>(null)

  useEffect(() => {
    if (!editing) setAddress(url)
  }, [url, editing])

  const setViewRef = useCallback((el: HTMLElement | null): void => {
    viewRef.current = el ? (el as unknown as Webview) : null
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
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
      setLoading(false)
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
      if (navUrl) setUrl(navUrl)
      syncHistory()
    }
    const onInPage = (event: Event): void => {
      const e = event as Event & { url?: string; isMainFrame?: boolean }
      if (e.isMainFrame && e.url) setUrl(e.url)
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
  }, [])

  const navigate = useCallback((input: string): void => {
    const target = toNavigationUrl(input)
    const view = viewRef.current
    if (!target || !view) return
    setEditing(false)
    void view.loadURL(target).catch(() => {})
  }, [])

  const host = hostOf(url)
  const isHttps = url.startsWith('https://')

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#121214]">
      {/* Flat dark header */}
      <div className="flex h-8 flex-none items-center gap-1 border-b border-[#252529] bg-[#1c1c1f] px-2">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={!canGoBack}
          onClick={() => viewRef.current?.goBack()}
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-[#8a8a90] hover:bg-[#2a2a2e] hover:text-[#ececec] disabled:opacity-30 disabled:pointer-events-none"
        >
          <ArrowLeft size={13} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={!canGoForward}
          onClick={() => viewRef.current?.goForward()}
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-[#8a8a90] hover:bg-[#2a2a2e] hover:text-[#ececec] disabled:opacity-30 disabled:pointer-events-none"
        >
          <ArrowRight size={13} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          aria-label={loading ? 'Stop' : 'Reload'}
          title={loading ? 'Stop' : 'Reload'}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-[#8a8a90] hover:bg-[#2a2a2e] hover:text-[#ececec]"
        >
          {loading ? <X size={13} strokeWidth={1.9} /> : <RotateCw size={12} strokeWidth={1.9} />}
        </button>
        <form
          className="relative ml-1 flex min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(address)
          }}
        >
          <div className="pointer-events-none absolute left-2.5 flex items-center text-[#6a6a70]">
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
            className="h-6 w-full rounded-full border border-[#2e2e32] bg-[#252529] pl-7 pr-2.5 text-[11px] text-[#e8e8ea] outline-none placeholder:text-[#6a6a70] focus:border-[#3a3a40] focus:bg-[#2a2a2e]"
          />
        </form>
        {host && !editing && <span className="mx-1 hidden max-w-[90px] flex-none truncate text-[10px] text-[#6a6a70] xl:block">{host}</span>}
      </div>
      {loading && (
        <div className="load-bar-track h-px flex-none" aria-hidden>
          <div className="load-bar h-full w-1/3" />
        </div>
      )}
      {!loading && loadError && (
        <div className="flex flex-none items-center justify-between gap-2 border-b border-[#3a2a2a] bg-[#1f1a1c] px-2 py-1 text-[11px] text-[#c9a0a0]">
          <span className="min-w-0 truncate">Error — {loadError}</span>
          <button
            type="button"
            className="flex-none rounded-md bg-[#2a2a2e] px-2 py-0.5 text-[10px] text-[#c9a0a0] hover:bg-[#303034]"
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
          allowpopups
          src={HOME_URL}
          className="absolute inset-0 h-full w-full"
        />
      </div>
    </div>
  )
})
