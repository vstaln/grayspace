import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Lock, Plus, RotateCcw, RotateCw, Search, X } from 'lucide-react'
import { BROWSER_PARTITION, HOME_URL, hostOf, toNavigationUrl, type Webview } from '../lib/browserShared'

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
  const views = useRef(new Map<string, Webview>())

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId])

  const patchTab = useCallback((id: string, patch: Partial<Tab>): void => {
    setTabs((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  useEffect(() => {
    if (!editing && activeTab) setAddress(activeTab.url)
  }, [activeTab, editing])

  const openTab = useCallback((url: string): void => {
    const safeUrl = url.trim() || HOME_URL
    const tab = makeTab(safeUrl)
    setTabs((current) => {
      if (current.length >= MAX_TABS) {
        return [...current.slice(1), tab]
      }
      return [...current, tab]
    })
    setActiveId(tab.id)
    setEditing(false)
  }, [])

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

      setTabs((current) => {
        const index = current.findIndex((t) => t.id === id)
        if (index === -1) return current

        if (current.length === 1) {
          const fresh = makeTab(HOME_URL)
          setActiveId(fresh.id)
          return [fresh]
        }

        const next = current.filter((t) => t.id !== id)
        if (id === activeId) {
          const nextIndex = Math.min(index, next.length - 1)
          setActiveId(next[nextIndex].id)
        }
        return next
      })
    },
    [activeId]
  )

  const navigate = useCallback(
    (input: string): void => {
      const url = toNavigationUrl(input)
      const view = views.current.get(activeId)
      if (!url || !view) return
      setEditing(false)
      void view.loadURL(url).catch(() => {})
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

  const handleClearDataAndReset = useCallback(async (): Promise<void> => {
    if (resetting) return
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
  }, [resetting])

  const isHttps = activeTab?.url?.startsWith('https://')

  return (
    <div
      className={`absolute inset-y-0 right-0 left-rail z-[40000] flex flex-col bg-[#121214] pt-10 ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      aria-hidden={!active}
    >
      {/* Header bar: Tabs and Address Bar */}
      <div className="flex flex-col border-b border-[#252529] bg-[#1c1c1f]">
        <div
          role="tablist"
          aria-label="Browser tabs"
          className="flex h-8 flex-none items-center gap-1 overflow-x-auto bg-transparent px-2"
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
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(tab.id)
                  }
                }}
                title={tab.url}
                className={`group flex h-7 min-w-[130px] max-w-[200px] flex-none cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-[12px] ${
                  isActive ? 'bg-[#2a2a2e] text-[#ececec]' : 'text-[#8a8a90] hover:bg-[#232326] hover:text-[#d4d4d8]'
                }`}
              >
                <span
                  className={`grid h-4 w-4 flex-none place-items-center rounded text-[9px] font-medium uppercase ${
                    isActive ? 'bg-[#3a3a40] text-[#ececec]' : 'bg-[#252529] text-[#8a8a90]'
                  }`}
                >
                  {tab.loading ? (
                    <span className="h-2 w-2 animate-spin rounded-full border border-[#8a8a90] border-t-transparent" />
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
                  className={`grid h-4 w-4 flex-none place-items-center rounded text-[#6a6a70] transition hover:bg-[#3a3a40] hover:text-[#ececec] group-hover:opacity-100 group-focus-within:opacity-100 ${
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
            className="grid h-6 w-6 flex-none place-items-center rounded-md text-[#6a6a70] hover:bg-[#232326] hover:text-[#ececec]"
          >
            <Plus size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Address & Controls Bar */}
        <div className="flex h-8 flex-none items-center gap-1.5 bg-transparent px-2.5">
          <button
            type="button"
            aria-label="Back"
            title="Back"
            disabled={!activeTab?.canGoBack}
            onClick={() => withActiveView((v) => v.goBack())}
            className="grid h-7 w-7 flex-none place-items-center rounded-md text-[#8a8a90] hover:bg-[#2a2a2e] hover:text-[#ececec] disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowLeft size={14} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label="Forward"
            title="Forward"
            disabled={!activeTab?.canGoForward}
            onClick={() => withActiveView((v) => v.goForward())}
            className="grid h-7 w-7 flex-none place-items-center rounded-md text-[#8a8a90] hover:bg-[#2a2a2e] hover:text-[#ececec] disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowRight size={14} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label={activeTab?.loading ? 'Stop' : 'Reload'}
            title={activeTab?.loading ? 'Stop' : 'Reload'}
            onClick={() => withActiveView((v) => (activeTab?.loading ? v.stop() : v.reload()))}
            className="grid h-7 w-7 flex-none place-items-center rounded-md text-[#8a8a90] hover:bg-[#2a2a2e] hover:text-[#ececec]"
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
            <div className="pointer-events-none absolute left-3 flex items-center text-[#6a6a70]">
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
              className="h-7 w-full rounded-full border border-[#2e2e32] bg-[#252529] pl-8 pr-3 text-[12px] text-[#e8e8ea] outline-none placeholder:text-[#6a6a70] focus:border-[#3a3a40] focus:bg-[#2a2a2e]"
            />
          </form>

          <button
            type="button"
            aria-label="Reset browser and clear data"
            title="Reset browser and clear data"
            onClick={() => void handleClearDataAndReset()}
            disabled={resetting}
            className="grid h-7 w-7 flex-none place-items-center rounded-md text-[#8a8a90] hover:bg-[#2a2a2e] hover:text-[#ececec] disabled:opacity-30"
          >
            <RotateCcw size={13} strokeWidth={1.9} className={resetting ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {activeTab?.loading && (
        <div className="load-bar-track h-px flex-none" aria-hidden>
          <div className="load-bar h-full w-1/3" />
        </div>
      )}
      {!activeTab?.loading && activeTab?.error && (
        <div className="flex flex-none items-center justify-between gap-3 border-b border-[#3a2a2a] bg-[#1f1a1c] px-3 py-1.5 text-xs text-[#c9a0a0]">
          <span className="min-w-0 truncate">Could not load — {activeTab.error}</span>
          <button
            type="button"
            className="flex-none rounded-md bg-[#2a2a2e] px-2.5 py-1 text-[11px] text-[#c9a0a0] hover:bg-[#303034]"
            onClick={() => withActiveView((v) => v.reload())}
          >
            Retry
          </button>
        </div>
      )}

      <div className="browser-surface relative flex-1">
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
    const onDomReady = (): void => {
      onPatch(id, { loading: false })
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
      onPatch(id, { loading: false })
      if (crashReloads < 1) {
        crashReloads += 1
        try {
          view.reload()
        } catch {}
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
      allowpopups
      src={tab.initialUrl}
      className={`absolute inset-0 h-full w-full ${visible ? 'z-10' : 'invisible z-0'}`}
    />
  )
}
