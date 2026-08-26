import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'
import { BROWSER_PARTITION, HOME_URL, hostOf, toNavigationUrl, type Webview } from '../lib/browserShared'

/**
 * One embedded page living on the canvas, distinct from the full-screen
 * Browser view (BrowserPane): a widget instance is a single tab pinned to a
 * spot on the board, useful for keeping a doc or dashboard visible alongside
 * terminals rather than switching views to see it. Guests share the pane's
 * session (BROWSER_PARTITION), so logins carry over either way.
 */
export default React.memo(function BrowserWidget(): React.JSX.Element {
  const [url, setUrl] = useState(HOME_URL)
  const [address, setAddress] = useState(HOME_URL)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  /** Main-frame load failure — without it a dead host looks like an eternal blank pane. */
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

  useEffect(() => {
    const view = viewRef.current
    if (!view) return undefined

    const syncHistory = (): void => {
      setCanGoBack(view.canGoBack())
      setCanGoForward(view.canGoForward())
    }
    const onStart = (): void => {
      setLoading(true)
      setLoadError(null)
    }
    const onStop = (): void => {
      setLoading(false)
      syncHistory()
    }
    const onFail = (event: Event): void => {
      const e = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      // ERR_ABORTED is our own Stop; subframe failures don't blank the page.
      if (e.errorCode === -3 || e.isMainFrame === false) return
      setLoading(false)
      setLoadError(e.errorDescription || 'the server could not be reached')
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
    // One automatic recovery per mount: a guest crash otherwise leaves a blank
    // widget with a stuck loading flag. A second crash stays down instead of
    // looping reloads forever.
    let crashReloads = 0
    const onCrashed = (): void => {
      console.warn('browser widget guest crashed', crashReloads < 1 ? '(auto-reloading once)' : '(stayed down)')
      setLoading(false)
      if (crashReloads < 1) {
        crashReloads += 1
        try {
          view.reload()
        } catch {
          /* the frame was already torn down */
        }
      }
    }

    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onInPage)
    view.addEventListener('crashed', onCrashed)
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onInPage)
      view.removeEventListener('crashed', onCrashed)
    }
    // Guests attach once per mount — the ref itself never changes identity.
  }, [])

  const navigate = useCallback((input: string): void => {
    const target = toNavigationUrl(input)
    const view = viewRef.current
    if (!target || !view) return
    setEditing(false)
    void view.loadURL(target).catch(() => {
      /* a dead host already surfaces through did-fail-load */
    })
  }, [])

  const host = hostOf(url)

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-raise">
      <div className="flex h-9 flex-none items-center gap-1 border-b border-white/10 bg-[#303236] px-2">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={!canGoBack}
          onClick={() => viewRef.current?.goBack()}
          className="grid h-[24px] w-[24px] flex-none place-items-center rounded-full text-[#c0c1c3] transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:text-[#777a7e]"
        >
          <ArrowLeft size={13} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={!canGoForward}
          onClick={() => viewRef.current?.goForward()}
          className="grid h-[24px] w-[24px] flex-none place-items-center rounded-full text-[#c0c1c3] transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:text-[#777a7e]"
        >
          <ArrowRight size={13} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          aria-label={loading ? 'Stop' : 'Reload'}
          title={loading ? 'Stop' : 'Reload'}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
          className="grid h-[24px] w-[24px] flex-none place-items-center rounded-full text-[#c0c1c3] transition-colors hover:bg-white/10 hover:text-white"
        >
          {loading ? <X size={13} strokeWidth={2.1} /> : <RotateCw size={12} strokeWidth={2.1} />}
        </button>
        <form
          className="ml-0.5 min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(address)
          }}
        >
          <input
            value={address}
            spellCheck={false}
            aria-label="Address and search"
            placeholder="Search Google or type a URL"
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
            className="h-[26px] w-full rounded-full border border-white/10 bg-[#45484d] px-3 text-[11.5px] text-white outline-none transition-colors placeholder:text-[#b0b2b5] focus:border-white/25"
          />
        </form>
        {host && !editing && <span className="mx-1 flex-none truncate text-[10px] text-text-faint">{host}</span>}
      </div>
      {loading && (
        <div className="h-0.5 flex-none overflow-hidden" aria-hidden>
          <div className="load-bar h-full w-1/4 rounded-full bg-accent/70" />
        </div>
      )}
      {!loading && loadError && (
        <div className="flex flex-none items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1 text-[11px] text-danger">
          <span className="min-w-0 truncate">Failed to load — {loadError}</span>
          <button
            type="button"
            className="flex-none rounded-[8px] border border-danger/40 px-2 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/15"
            onClick={() => viewRef.current?.reload()}
          >
            Retry
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
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
