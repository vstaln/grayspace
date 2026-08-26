import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Plus, RotateCw, X } from 'lucide-react'
import { BROWSER_PARTITION, HOME_URL, hostOf, toNavigationUrl, type Webview } from '../lib/browserShared'

interface Tab {
  id: string
  /** Fixed at creation — the `src` attribute must not change once attached;
   * later navigation goes through `loadURL` instead. */
  initialUrl: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set when the page's main frame failed to load; cleared on the next start. */
  error?: string | null
}

let tabCounter = 0
function makeTab(url: string): Tab {
  tabCounter += 1
  return {
    id: `tab-${tabCounter}`,
    initialUrl: url,
    url,
    title: 'New tab',
    loading: true,
    canGoBack: false,
    canGoForward: false
  }
}

interface Props {
  /** The pane keeps its tabs alive while hidden, so a page survives a trip to
   * the canvas and back. */
  active: boolean
}

export default function BrowserPane({ active }: Props): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab(HOME_URL)])
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id ?? '')
  const [address, setAddress] = useState(HOME_URL)
  /** True while the user is editing the field, so a background load's URL does
   * not overwrite what they are halfway through typing. */
  const [editing, setEditing] = useState(false)
  const views = useRef(new Map<string, Webview>())

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId])

  const patchTab = useCallback((id: string, patch: Partial<Tab>): void => {
    setTabs((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  // The field follows the active tab unless the user is typing in it.
  useEffect(() => {
    if (!editing && activeTab) setAddress(activeTab.url)
  }, [activeTab, editing])

  const openTab = useCallback((url: string): void => {
    const tab = makeTab(url)
    setTabs((current) => [...current, tab])
    setActiveId(tab.id)
    setEditing(false)
  }, [])

  // A popup blocked in main (target=_blank, window.open) arrives here as a tab.
  useEffect(() => window.api.browser.onOpenTab((url) => openTab(url)), [openTab])

  const closeTab = useCallback(
    (id: string): void => {
      const index = tabs.findIndex((t) => t.id === id)
      if (index === -1) return
      setEditing(false)
      if (tabs.length === 1) {
        // The pane always shows something; closing the last tab resets it.
        const fresh = makeTab(HOME_URL)
        setTabs([fresh])
        setActiveId(fresh.id)
        return
      }
      const next = tabs.filter((t) => t.id !== id)
      setTabs(next)
      // Closing the active tab hands focus to its right-hand neighbour, or to
      // the new last tab when it was the rightmost.
      if (id === activeId) setActiveId(next[Math.min(index, next.length - 1)].id)
    },
    [tabs, activeId]
  )

  const navigate = useCallback(
    (input: string): void => {
      const url = toNavigationUrl(input)
      const view = views.current.get(activeId)
      if (!url || !view) return
      setEditing(false)
      void view.loadURL(url).catch(() => {
        /* a dead host already surfaces through did-fail-load */
      })
    },
    [activeId]
  )

  const withActiveView = useCallback(
    (fn: (view: Webview) => void): void => {
      const view = views.current.get(activeId)
      if (view) fn(view)
    },
    [activeId]
  )

  const registerView = useCallback((id: string, view: Webview | null): void => {
    if (view) views.current.set(id, view)
    else views.current.delete(id)
  }, [])

  return (
    <div
      // Above every canvas layer, below the title bar's z-[50000] so the
      // switcher and window controls stay reachable. Left edge starts past
      // the rail so the sidebar keeps its own column instead of floating
      // on top of this pane's content.
      className={`absolute inset-y-0 right-0 left-rail z-[40000] flex flex-col pt-10 ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      aria-hidden={!active}
    >
      {/* Tab strip */}
      <div role="tablist" aria-label="Browser tabs" className="flex h-9 flex-none items-end gap-1 overflow-x-auto border-b border-white/10 bg-[#292b2f] px-2">
        {tabs.map((tab) => {
          const host = hostOf(tab.url)
          const label = tab.title && tab.title !== 'New tab' ? tab.title : host || 'New tab'
          const isActive = tab.id === activeId
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => {
                setActiveId(tab.id)
                setEditing(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setActiveId(tab.id)
                  setEditing(false)
                }
              }}
              // Middle click closes a tab, as it does in every other browser.
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(tab.id)
                }
              }}
              title={tab.url}
              className={`group flex h-[27px] min-w-[112px] max-w-[210px] flex-none cursor-pointer select-none items-center gap-1.5 rounded-full border border-transparent px-3 text-[12px] transition-colors ${
                isActive
                  ? 'bg-[#45484d] text-white'
                  : 'text-[#b8babd] hover:bg-[#36393e] hover:text-white'
              }`}
            >
              <span
                  className={`grid h-[15px] w-[15px] flex-none place-items-center rounded-full text-[9px] font-semibold uppercase ${
                    tab.loading ? 'bg-white/20 text-white' : 'bg-black/15 text-[#d0d1d3]'
                  }`}
              >
                {host.charAt(0) || '·'}
              </span>
              <span className="flex-1 truncate">{label}</span>
              <button
                type="button"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                className="grid h-[16px] w-[16px] flex-none place-items-center rounded-full text-[#aeb0b3] opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <X size={11} strokeWidth={2.4} />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={() => openTab(HOME_URL)}
          className="mb-1 grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-[#b8babd] transition-colors hover:bg-[#36393e] hover:text-white"
        >
          <Plus size={14} strokeWidth={2.2} />
        </button>
      </div>

      {/* Navigation bar */}
      <div className="flex h-10 flex-none items-center gap-1 border-b border-white/10 bg-[#303236] px-3">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={!activeTab?.canGoBack}
          onClick={() => withActiveView((v) => v.goBack())}
          className="grid h-[27px] w-[27px] flex-none place-items-center rounded-full text-[#c0c1c3] transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:text-[#777a7e]"
        >
          <ArrowLeft size={15} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={!activeTab?.canGoForward}
          onClick={() => withActiveView((v) => v.goForward())}
          className="grid h-[27px] w-[27px] flex-none place-items-center rounded-full text-[#c0c1c3] transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:text-[#777a7e]"
        >
          <ArrowRight size={15} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          aria-label={activeTab?.loading ? 'Stop' : 'Reload'}
          title={activeTab?.loading ? 'Stop' : 'Reload'}
          onClick={() => withActiveView((v) => (activeTab?.loading ? v.stop() : v.reload()))}
          className="grid h-[27px] w-[27px] flex-none place-items-center rounded-full text-[#c0c1c3] transition-colors hover:bg-white/10 hover:text-white"
        >
          {activeTab?.loading ? <X size={15} strokeWidth={2.1} /> : <RotateCw size={14} strokeWidth={2.1} />}
        </button>

        <form
          className="ml-1 flex-1"
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
                setAddress(activeTab?.url ?? '')
                e.currentTarget.blur()
              }
            }}
            className="h-[28px] w-full rounded-full border border-white/10 bg-[#45484d] px-3 text-[12.5px] text-white outline-none transition-colors placeholder:text-[#b0b2b5] focus:border-white/25"
          />
        </form>
      </div>

      {/* Loading progress + load-failure feedback for the visible tab. */}
      {activeTab?.loading && (
        <div className="h-0.5 flex-none overflow-hidden" aria-hidden>
          <div className="load-bar h-full w-1/4 rounded-full bg-accent/70" />
        </div>
      )}
      {!activeTab?.loading && activeTab?.error && (
        <div className="flex flex-none items-center justify-between gap-3 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
          <span className="min-w-0 truncate">Page failed to load — {activeTab.error}</span>
          <button
            type="button"
            className="flex-none rounded-[8px] border border-danger/40 px-2 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger/15"
            onClick={() => withActiveView((v) => v.reload())}
          >
            Retry
          </button>
        </div>
      )}

      {/* Pages. Every tab stays mounted; only the active one is visible, and
          `visibility` rather than `display` so a hidden guest keeps its size. */}
      <div className="relative flex-1 bg-bg-raise">
        {tabs.map((tab) => (
          <TabFrame
            key={tab.id}
            tab={tab}
            visible={tab.id === activeId}
            onPatch={patchTab}
            onRegister={registerView}
          />
        ))}
      </div>
    </div>
  )
}

interface TabFrameProps {
  tab: Tab
  visible: boolean
  onPatch: (id: string, patch: Partial<Tab>) => void
  onRegister: (id: string, view: Webview | null) => void
}

/** One guest page. Owns its own listeners so tabs can come and go freely. */
function TabFrame({ tab, visible, onPatch, onRegister }: TabFrameProps): React.JSX.Element {
  const ref = useRef<Webview | null>(null)
  const id = tab.id
  // Stable per-tab: an inline arrow ref would be recreated every render, and
  // React would call ref(null)+ref(el) each time — churning the view registry
  // (delete+set) on every parent re-render for no reason.
  const setViewRef = useCallback(
    (el: HTMLElement | null): void => {
      const view = el ? (el as unknown as Webview) : null
      ref.current = view
      onRegister(id, view)
    },
    [id, onRegister]
  )

  useEffect(() => {
    const view = ref.current
    if (!view) return undefined

    const syncHistory = (): void => {
      onPatch(id, { canGoBack: view.canGoBack(), canGoForward: view.canGoForward() })
    }
    const onStart = (): void => onPatch(id, { loading: true, error: null })
    const onStop = (): void => {
      onPatch(id, { loading: false })
      syncHistory()
    }
    // A main-frame load failure used to leave a blank pane with no way to tell
    // "still loading" from "dead host". ERR_ABORTED (-3) is our own Stop, not a
    // failure; subframe failures don't block the page and stay invisible.
    const onFail = (event: Event): void => {
      const e = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (e.errorCode === -3 || e.isMainFrame === false) return
      onPatch(id, { loading: false, error: e.errorDescription || 'the server could not be reached' })
      syncHistory()
    }
    const onNavigate = (event: Event): void => {
      const url = (event as Event & { url?: string }).url
      if (url) onPatch(id, { url })
      syncHistory()
    }
    const onInPage = (event: Event): void => {
      const e = event as Event & { url?: string; isMainFrame?: boolean }
      if (e.isMainFrame && e.url) onPatch(id, { url: e.url })
      syncHistory()
    }
    const onTitle = (event: Event): void => {
      const title = (event as Event & { title?: string }).title
      if (title) onPatch(id, { title })
    }

    // One automatic recovery per mount: a guest renderer crash (renderer-gone)
    // leaves a blank pane and a stuck `loading` flag. A page that crashes
    // again after this reload stays down rather than looping forever.
    let crashReloads = 0
    const onCrashed = (): void => {
      console.warn(`browser tab ${id} crashed`, crashReloads < 1 ? '(auto-reloading once)' : '(stayed down)')
      onPatch(id, { loading: false })
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
    view.addEventListener('page-title-updated', onTitle)
    view.addEventListener('crashed', onCrashed)
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onInPage)
      view.removeEventListener('page-title-updated', onTitle)
      view.removeEventListener('crashed', onCrashed)
    }
  }, [id, onPatch])

  return (
    <webview
      ref={setViewRef}
      // `partition` must reach the element before it starts loading, so it is
      // written ahead of `src`; main pins it again at attach time regardless.
      partition={BROWSER_PARTITION}
      allowpopups
      src={tab.initialUrl}
      // Never `visible` on the active tab: `visibility` inherits, so an explicit
      // `visible` here would punch through the pane's own hidden state and paint
      // the page over the canvas. Inactive tabs opt out, the active one inherits.
      className={`absolute inset-0 h-full w-full ${visible ? 'z-10' : 'invisible z-0'}`}
    />
  )
}
