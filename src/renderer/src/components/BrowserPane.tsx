import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Lock, Plus, RotateCcw, RotateCw, Search, X } from 'lucide-react'
import { BROWSER_PARTITION, HOME_URL, hostOf, toNavigationUrl, type Webview } from '../lib/browserShared'
import { useConfirm } from './ConfirmDialog'

interface Tab {
  id: string
  initialUrl: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string | null
}

const MAX_TABS = 20

let tabCounter = 0
function makeTab(url: string = HOME_URL): Tab {
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
  active: boolean
}

export default function BrowserPane({ active }: Props): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab(HOME_URL)])
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id ?? '')
  const [address, setAddress] = useState(HOME_URL)
  const [editing, setEditing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [tabNotice, setTabNotice] = useState<string | null>(null)
  const tabNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirm = useConfirm()
  // Only the active tab plus the 3 most recently active ones keep a live
  // webview mounted — older background tabs keep their metadata but render
  // nothing until reactivated, instead of every tab holding a process.
  const [recentIds, setRecentIds] = useState<string[]>(() => [tabs[0]?.id ?? ''])
  const liveIds = useMemo(() => new Set(recentIds), [recentIds])
  useEffect(() => {
    setRecentIds((prev) => [activeId, ...prev.filter((id) => id !== activeId)].slice(0, 4))
  }, [activeId])
  const views = useRef(new Map<string, Webview>())
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId])

  const patchTab = useCallback((id: string, patch: Partial<Tab>): void => {
    setTabs((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  useEffect(() => {
    if (!editing && activeTab) setAddress(activeTab.url)
  }, [activeTab, editing])

  const showTabNotice = useCallback((msg: string): void => {
    setTabNotice(msg)
    if (tabNoticeTimer.current !== null) clearTimeout(tabNoticeTimer.current)
    tabNoticeTimer.current = setTimeout(() => {
      tabNoticeTimer.current = null
      setTabNotice(null)
    }, 3000)
  }, [])

  useEffect(
    () => () => {
      if (tabNoticeTimer.current !== null) clearTimeout(tabNoticeTimer.current)
    },
    []
  )

  const openTab = useCallback(
    (url: string): void => {
      const current = tabsRef.current
      if (current.length >= MAX_TABS) {
        // Never silently evict the oldest tab — block and say why.
        showTabNotice('Tab limit reached — close one to open another.')
        return
      }
      const safeUrl = url.trim() || HOME_URL
      const tab = makeTab(safeUrl)
      setTabs([...current, tab])
      setActiveId(tab.id)
      setEditing(false)
    },
    [showTabNotice]
  )

  useEffect(() => {
    const unsub = window.api.browser.onOpenTab((url) => {
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        openTab(url)
      }
    })
    return () => unsub()
  }, [openTab])

  const closeTab = useCallback(
    (id: string): void => {
      views.current.delete(id)
      setEditing(false)

      // Pure computation on the render-synced list — no setter-in-updater.
      const current = tabsRef.current
      const index = current.findIndex((t: Tab) => t.id === id)
      if (index === -1) return

      if (current.length === 1) {
        const fresh = makeTab(HOME_URL)
        setTabs([fresh])
        setActiveId(fresh.id)
        return
      }

      const next = current.filter((t: Tab) => t.id !== id)
      setTabs(next)
      if (id === activeId) {
        const nextIndex = Math.min(index, next.length - 1)
        setActiveId(next[nextIndex].id)
      }
    },
    [activeId]
  )

  const navigate = useCallback(
    (input: string): void => {
      const url = toNavigationUrl(input)
      const view = views.current.get(activeId)
      if (!url || !view) return
      // Optimistically retain the requested URL. If DNS/TLS/navigation fails,
      // `did-navigate` never arrives and the old effect used to restore the
      // previous address, making retry/editing needlessly difficult.
      patchTab(activeId, { url, loading: true, error: null })
      setAddress(url)
      setEditing(false)
      void view.loadURL(url).catch(() => {})
    },
    [activeId, patchTab]
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

  const handleClearDataAndReset = useCallback(async (): Promise<void> => {
    if (resetting) return
    // One click destroys every tab — confirm first.
    const ok = await confirm('Reset the browser and clear all browsing data? All tabs will be closed.', {
      danger: true,
      title: 'Reset browser',
      confirmLabel: 'Reset'
    })
    if (!ok) return
    setResetting(true)
    try {
      if (window.api.browser.clearData) {
        await window.api.browser.clearData()
      }
      const fresh = makeTab(HOME_URL)
      views.current.clear()
      setTabs([fresh])
      setActiveId(fresh.id)
      setAddress(HOME_URL)
    } finally {
      setResetting(false)
    }
  }, [resetting, confirm])

  const isHttps = activeTab?.url?.startsWith('https://')

  return (
    <div
      // Shared full-pane left offset: the pane is only visible when the app
      // sidebar is expanded (200px outside chat — see geometry.sidebarExpanded
      // in design/tokens.ts; ChatPane uses the 240px chat width). Matches
      // CodeView so Browser/Chat/Code edges agree.
      className={`absolute inset-y-0 right-0 left-[200px] z-[40000] flex flex-col browser-surface pt-10 ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      aria-hidden={!active}
    >
      {/* Header bar: Tabs and Address Bar */}
      <div className="browser-chrome flex flex-col">
        <div
          role="tablist"
          aria-label="Browser tabs"
          className="browser-tab-strip flex h-8 flex-none items-center gap-1 overflow-x-auto px-2"
        >
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
                data-tab-id={tab.id}
                onClick={() => {
                  setActiveId(tab.id)
                  setEditing(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActiveId(tab.id)
                    setEditing(false)
                  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault()
                    const idx = tabs.findIndex((t) => t.id === tab.id)
                    const delta = e.key === 'ArrowRight' ? 1 : -1
                    const next = tabs[(idx + delta + tabs.length) % tabs.length]
                    if (next) {
                      setActiveId(next.id)
                      setEditing(false)
                      requestAnimationFrame(() => {
                        e.currentTarget.parentElement
                          ?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)
                          ?.focus()
                      })
                    }
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(tab.id)
                  }
                }}
                title={tab.url}
                className={`browser-tab group flex h-7 min-w-[130px] max-w-[200px] flex-none cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-[12px] ${
                  isActive ? 'browser-tab-active' : 'browser-tab-idle'
                }`}
              >
                <span
                  className={`grid h-4 w-4 flex-none place-items-center rounded text-[9px] font-medium uppercase ${
                    isActive ? 'bg-bg-hover text-text' : 'bg-bg-raise text-text-faint'
                  }`}
                >
                  {tab.loading ? (
                    <span className="h-2 w-2 animate-spin rounded-full border border-text-faint border-t-transparent" />
                  ) : (
                    host.charAt(0) || '·'
                  )}
                </span>
                <span className="flex-1 truncate">{label}</span>
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      closeTab(tab.id)
                    }
                  }}
                  className={`browser-icon-btn grid h-4 w-4 flex-none place-items-center rounded group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 ${
                    isActive ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            aria-label="New tab"
            title="New tab"
            onClick={() => openTab(HOME_URL)}
            className="browser-icon-btn grid h-6 w-6 flex-none place-items-center rounded-md"
          >
            <Plus size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Address & Controls Bar */}
        <div className="flex h-8 flex-none items-center gap-1.5 px-2.5">
          <button
            type="button"
            aria-label="Back"
            title="Back"
            disabled={!activeTab?.canGoBack}
            onClick={() => withActiveView((v) => v.goBack())}
            className="browser-icon-btn grid h-7 w-7 flex-none place-items-center rounded-md disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowLeft size={14} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label="Forward"
            title="Forward"
            disabled={!activeTab?.canGoForward}
            onClick={() => withActiveView((v) => v.goForward())}
            className="browser-icon-btn grid h-7 w-7 flex-none place-items-center rounded-md disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowRight size={14} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label={activeTab?.loading ? 'Stop' : 'Reload'}
            title={activeTab?.loading ? 'Stop' : 'Reload'}
            onClick={() => withActiveView((v) => (activeTab?.loading ? v.stop() : v.reload()))}
            className="browser-icon-btn grid h-7 w-7 flex-none place-items-center rounded-md"
          >
            {activeTab?.loading ? <X size={14} strokeWidth={1.9} /> : <RotateCw size={13} strokeWidth={1.9} />}
          </button>

          <form
            className="relative ml-1 flex flex-1 items-center"
            onSubmit={(e) => {
              e.preventDefault()
              navigate(address)
            }}
          >
            <div className="pointer-events-none absolute left-3 flex items-center text-text-faint">
              {isHttps ? <Lock size={11} strokeWidth={2} /> : <Search size={11} strokeWidth={2} />}
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
                  setAddress(activeTab?.url ?? '')
                  e.currentTarget.blur()
                }
              }}
              className="browser-omnibox h-7 w-full rounded-full pl-8 pr-3 text-[12px] outline-none placeholder:text-text-faint"
            />
          </form>

          <button
            type="button"
            aria-label="Reset browser and clear data"
            title="Reset browser and clear data"
            onClick={() => void handleClearDataAndReset()}
            disabled={resetting}
            className="browser-icon-btn grid h-7 w-7 flex-none place-items-center rounded-md disabled:opacity-30"
          >
            <RotateCcw size={13} strokeWidth={1.9} className={resetting ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {tabNotice && (
        <div role="status" className="flex-none border-b border-line-soft bg-bg-panel px-3 py-1.5 text-[11px] text-text-dim">
          {tabNotice}
        </div>
      )}
      {activeTab?.loading && (
        <div className="load-bar-track h-px flex-none" aria-hidden>
          <div className="load-bar h-full w-1/3" />
        </div>
      )}
      {!activeTab?.loading && activeTab?.error && (
        <div className="flex flex-none items-center justify-between gap-3 border-b border-danger/40 bg-bg-panel px-3 py-1.5 text-xs text-danger">
          <span className="min-w-0 truncate">Could not load — {activeTab.error}</span>
          <button
            type="button"
            className="flex-none rounded-md bg-bg-raise px-2.5 py-1 text-[11px] text-danger hover:bg-bg-hover"
            onClick={() => withActiveView((v) => v.reload())}
          >
            Retry
          </button>
        </div>
      )}

      <div className="browser-surface relative flex-1">
        {tabs.map((tab) =>
          // Suspend background tabs beyond the active + last 3: tab metadata
          // stays in state, but no webview mounts until reactivated.
          liveIds.has(tab.id) ? (
            <TabFrame
              key={tab.id}
              tab={tab}
              visible={tab.id === activeId}
              onPatch={patchTab}
              onRegister={registerView}
            />
          ) : null
        )}
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

function TabFrame({ tab, visible, onPatch, onRegister }: TabFrameProps): React.JSX.Element {
  const ref = useRef<Webview | null>(null)
  const id = tab.id
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
      try {
        onPatch(id, { canGoBack: view.canGoBack(), canGoForward: view.canGoForward() })
      } catch {}
    }
    const onStart = (): void => {
      onPatch(id, { loading: true, error: null })
    }
    const onStop = (): void => {
      onPatch(id, { loading: false })
      syncHistory()
    }
    // DOM readiness is not navigation completion; leave the loading state to
    // did-stop-loading so slow resources keep the progress indicator honest.
    const onDomReady = (): void => {
      syncHistory()
    }
    const onFail = (event: Event): void => {
      const e = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (e.errorCode === -3 || e.isMainFrame === false) return
      onPatch(id, { loading: false, error: e.errorDescription || 'server unreachable' })
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

    let crashReloads = 0
    const onCrashed = (): void => {
      crashReloads++
      onPatch(id, { loading: false })
      if (crashReloads < 2) {
        try { view.reload() } catch {}
      } else {
        onPatch(id, { loading: false, error: 'The web page process crashed. Click retry or enter a new URL.' })
      }
    }

    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-finish-load', onDomReady)
    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onInPage)
    view.addEventListener('page-title-updated', onTitle)
    view.addEventListener('crashed', onCrashed)
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-finish-load', onDomReady)
      view.removeEventListener('dom-ready', onDomReady)
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
        partition={BROWSER_PARTITION}
        allowpopups={'true' as unknown as boolean}
        src={tab.url}
        className={`absolute inset-0 h-full w-full ${visible ? 'z-10' : 'invisible z-0'}`}
      />
  )
}
