import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar, { SettingsModal } from './components/Sidebar'
import WidgetFrame, { forgetAgentSelection } from './components/WidgetFrame'
import { forgetTerminalViewport } from './components/TerminalWidget'
import { clearInitialCommand } from './lib/pendingTerminalCommands'
import ContextMenu from './components/ContextMenu'
import TitleBar from './components/TitleBar'
import type { WorkView } from './components/TitleBar'
import { useCanvas } from './hooks/useCanvas'
import { Camera, clampWidgetSize, MIN_H, NON_MAXIMIZABLE, Point, ResizeDir, WidgetKind, WIDGET_DEFAULTS, WIDGET_H, WIDGET_W } from './types'
import ErrorBoundary from './components/ErrorBoundary'
import StrokesLayer from './components/StrokesLayer'
import ConnectionsLayer from './components/ConnectionsLayer'
import { ThemeProvider, useTheme, wallpaperBackgroundImage } from './theme'
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog'
import { useSettings } from './hooks/useSettings'
import { DRAW_CLICK_THRESHOLD_PX } from './lib/canvasMetrics'
import { ToastContainer, usePersistErrorToasts, useTerminalBackendErrorToasts, useToasts } from './components/Toast'
import Toolbar from './components/Toolbar'
import { queueInitialCommand } from './lib/pendingTerminalCommands'



const CodeView = lazy(() => import('./components/CodeView'))


let localCounter = 0



const TITLE_BAR_HEIGHT = 40

function titleBarWorldY(cameraY: number, zoom: number): number {
  return (TITLE_BAR_HEIGHT - cameraY) / (zoom || 1)
}

export default function App(): React.JSX.Element {




  const [activeView, setActiveView] = useState<WorkView>('canvas')
  const [codeSidebarCollapsed, setCodeSidebarCollapsed] = useState(false)
  const toggleCodeSidebar = useCallback(() => setCodeSidebarCollapsed((collapsed) => !collapsed), [])


  const [codeStarted, setCodeStarted] = useState(false)
  const codeWorkspaceIdRef = useRef('code-default')
  const codeWorkspaceFolderRef = useRef<string | null>(null)
  const workspaceViewLoadRef = useRef(0)




  useEffect(() => {
    let mounted = true
    const restoreWorkspaceView = (workspaceId: string): void => {
      const request = ++workspaceViewLoadRef.current
      void window.api.code.load().then((snap) => {
        if (!mounted || request !== workspaceViewLoadRef.current || codeWorkspaceIdRef.current !== workspaceId) return
        if ((snap?.sessions ?? []).length > 0) setCodeStarted(true)
        const av = (snap as unknown as { activeView?: string } | null | undefined)?.activeView ?? null

        if (av === 'code') {
          setCodeStarted(true)
          setActiveView('code')
        } else if (av === 'browser') {

          setActiveView('canvas')
        } else if (av === 'canvas') {
          setActiveView('canvas')
        }
      }).catch(() => {})
    }
    void window.api.workspace.codeWorkspaces().then((state) => {
      if (!mounted) return
      codeWorkspaceIdRef.current = state?.activeId ?? 'code-default'
      codeWorkspaceFolderRef.current = state?.folder ?? null
      restoreWorkspaceView(codeWorkspaceIdRef.current)
    }).catch(() => {})
    const offWorkspace = window.api.workspace.onCodeWorkspaceChange((state) => {
      const scopeChanged =
        codeWorkspaceIdRef.current !== (state?.activeId ?? 'code-default') ||
        codeWorkspaceFolderRef.current !== (state?.folder ?? null)
      codeWorkspaceIdRef.current = state?.activeId ?? 'code-default'
      codeWorkspaceFolderRef.current = state?.folder ?? null
      // Renaming a workspace changes its label, not the saved view slot.
      if (scopeChanged) restoreWorkspaceView(codeWorkspaceIdRef.current)
    })
    const offCode = window.api.code.onChange((snap) => {
      if ((snap?.sessions ?? []).length > 0) setCodeStarted((prev) => prev || true)
    })
    return () => {
      mounted = false
      workspaceViewLoadRef.current += 1
      offWorkspace()
      offCode()
    }
  }, [])

  const showView = useCallback((view: WorkView): void => {
    if (view === 'code') setCodeStarted(true)
    setActiveView(view)
    if (typeof window.api.code.saveSync === 'function') {
      try { window.api.code.saveSync({ activeView: view, codeWorkspaceId: codeWorkspaceIdRef.current }) } catch {}
    }
    void window.api.code.save({ activeView: view, codeWorkspaceId: codeWorkspaceIdRef.current }).catch(() => {})
  }, [])

  useEffect(() => {
    const onBeforeUnload = (): void => {
      if (typeof window.api.code.saveSync === 'function') {
        try {
          window.api.code.saveSync({ activeView, codeWorkspaceId: codeWorkspaceIdRef.current })
        } catch {}
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onBeforeUnload)
    }
  }, [activeView])

  const { toasts, push, dismiss } = useToasts()
  usePersistErrorToasts(push)
  useTerminalBackendErrorToasts(push)

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ConfirmProvider>
          <div className="relative flex h-full flex-col">
            <Wallpaper />
            <TitleBar
              activeView={activeView}
              onViewChange={showView}
              codeSidebarCollapsed={codeSidebarCollapsed}
              onToggleCodeSidebar={toggleCodeSidebar}
            />
            <SettingsModal listenForToolbar />
            <div className="flex flex-1 flex-col">
              <ErrorBoundary>
                <OrcSpaceCanvas
                  active={activeView === 'canvas'}
                  activeView={activeView}
                  codeSidebarCollapsed={codeSidebarCollapsed}
                />
              </ErrorBoundary>
            </div>
            {codeStarted && (
              <ErrorBoundary>
                <Suspense fallback={<div role="status" className="grid h-full place-items-center text-text-dim">Loading…</div>}>
                  <CodeView active={activeView === 'code'} sidebarCollapsed={codeSidebarCollapsed} />
                </Suspense>
              </ErrorBoundary>
            )}
            <ToastContainer toasts={toasts} onDismiss={dismiss} />
          </div>
        </ConfirmProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}






function Wallpaper(): React.JSX.Element | null {
  const { theme, background, backgroundLoaded, dim, blur, pickBackground } = useTheme()
  if (theme !== 'photo') return null
  const bgImg = wallpaperBackgroundImage(background)
  const blurPx = Math.round((blur / 100) * 32)
  const dimRatio = dim / 100

  return (
    <>
      <div className="wallpaper-container" aria-hidden="true">
        <div
          className="wallpaper-image"
          style={{
            backgroundImage: bgImg,


            filter: blurPx > 0 ? `blur(${blurPx}px)` : 'none'
          }}
        />
        {dimRatio > 0 && (
          <div
            className="wallpaper-dim"
            style={{ backgroundColor: `rgba(8, 8, 8, ${dimRatio})` }}
          />
        )}
      </div>
      {!background && backgroundLoaded && (
        <div className="pointer-events-none absolute inset-x-0 top-10 z-[900] flex justify-center">
          <button
            type="button"
            className="pointer-events-auto rounded-[10px] border border-line bg-bg-panel/90 px-3 py-1.5 text-[11px] text-text-dim shadow-sm hover:bg-bg-hover hover:text-text"
            onClick={() => void pickBackground()}
          >
            Photo theme needs a background — choose one
          </button>
        </div>
      )}
    </>
  )
}

function OrcSpaceCanvas({
  active,
  activeView,
  codeSidebarCollapsed
}: {
  active: boolean
  activeView: WorkView
  codeSidebarCollapsed: boolean
}): React.JSX.Element {
  const { settings, update: updateSettings } = useSettings()
  const canvas = useCanvas()
  const {
    widgets,
    camera,
    setCamera,
    topZ,
    screenToWorld,
    tool,
    setTool,
    strokes,
    strokeColor,
    setStrokeColor,
    connections
  } = canvas
  const confirm = useConfirm()
  const mainRef = useRef<HTMLElement>(null)


  const mainOffsetRef = useRef({ left: 0, top: 0 })
  const [mainSize, setMainSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      mainOffsetRef.current = { left: r.left, top: r.top }
      setMainSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])




  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const widgetsRef = useRef(widgets)
  widgetsRef.current = widgets




  useEffect(() => {
    window.dispatchEvent(new Event('orcspace:camera-move'))
  }, [camera.x, camera.y, camera.zoom])





  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      return screenToWorld(clientX - mainOffsetRef.current.left, clientY - mainOffsetRef.current.top)
    },
    [screenToWorld]
  )

  const [menu, setMenu] = useState<Point | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  editingRef.current = editingId
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [canvasNotice, setCanvasNotice] = useState<string | null>(null)
  const panRafRef = useRef<number | null>(null)
  const panPendingRef = useRef<Camera | null>(null)
  useEffect(() => {
    return () => {
      if (panRafRef.current !== null) cancelAnimationFrame(panRafRef.current)
    }
  }, [])

  useEffect(() => {
    void window.api.workspace
      .getDir()
      .then(setWorkspaceDir)
      .catch((err) => console.warn('workspace:getDir failed', err))
    return window.api.workspace.onDirChange(setWorkspaceDir)
  }, [])

  useEffect(() => {
    if (!canvasNotice) return
    const timer = window.setTimeout(() => setCanvasNotice(null), 3200)
    return () => window.clearTimeout(timer)
  }, [canvasNotice])



  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (editingRef.current) return setEditingId(null)
      const target = e.target as HTMLElement | null

      if (document.querySelector('[role="menu"]:not([aria-hidden="true"]), [role="contextmenu"]:not([aria-hidden="true"]), [data-menu-open="true"]')) {
        return
      }



      if (target?.closest?.('input,textarea,select,.xterm,.term-shell,.is-terminal')) return
      if (menu) return setMenu(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu])

  const closeWidget = useCallback(
    (id: string): void => {

      canvas.removeWidget(id)
      setEditingId((cur) => (cur === id ? null : cur))
      forgetAgentSelection(id)
      clearInitialCommand(id)
      forgetTerminalViewport(id)


      handlerCacheRef.current.delete(id)
    },
    [canvas.removeWidget]
  )



  const clampToVisibleWorld = useCallback(
    (point: Point, w: number, h: number): Point => {
      const zoom = camera.zoom || 1
      const viewW = mainSize.w > 0 ? mainSize.w : window.innerWidth
      const viewH = mainSize.h > 0 ? mainSize.h : window.innerHeight
      const margin = 32 / zoom
      const minX = (-camera.x) / zoom + margin
      const minY = Math.max((-camera.y) / zoom + margin, titleBarWorldY(camera.y, zoom))
      const maxX = (viewW - camera.x) / zoom - margin - Math.min(w, viewW / zoom - margin * 2)
      const maxY = (viewH - camera.y) / zoom - margin - Math.min(h, viewH / zoom - margin * 2)
      return {
        x: maxX >= minX ? Math.min(Math.max(point.x, minX), maxX) : minX,
        y: maxY >= minY ? Math.min(Math.max(point.y, minY), maxY) : minY
      }
    },
    [camera.x, camera.y, camera.zoom, mainSize.w, mainSize.h]
  )

  const spawnTerminalAtCenter = useCallback((): void => {


    const cx = mainSize.w > 0 ? mainSize.w / 2 : window.innerWidth / 2
    const cy = mainSize.h > 0 ? mainSize.h / 2 : window.innerHeight / 2
    const halfW = WIDGET_W / 2
    const halfH = WIDGET_H / 2



    const center = toWorld(cx, cy)
    const world = { x: center.x - halfW, y: center.y - halfH }
    const clamped = clampToVisibleWorld(world, WIDGET_W, WIDGET_H)
    if (!canvas.addWidget(clamped)) {
      setCanvasNotice('Canvas is full — close a widget before adding another.')
    }
  }, [canvas.addWidget, toWorld, mainSize.w, mainSize.h, clampToVisibleWorld])

  useEffect(() => {
    const onNewTerminal = (): void => spawnTerminalAtCenter()
    window.addEventListener('orcspace:new-terminal', onNewTerminal)
    return () => window.removeEventListener('orcspace:new-terminal', onNewTerminal)
  }, [spawnTerminalAtCenter])

  useEffect(() => {
    const onNotice = (event: Event): void => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message
      if (message) setCanvasNotice(message)
    }
    window.addEventListener('orcspace:canvas-notice', onNotice)
    return () => window.removeEventListener('orcspace:canvas-notice', onNotice)
  }, [])

  const placeWidget = useCallback(
    (kind: WidgetKind, point: Point, requestedId?: string, title?: string): string | null => {
      const defaults = WIDGET_DEFAULTS[kind]
      const w = defaults.w
      const h = defaults.h
      const id = requestedId || `${kind}-${Date.now()}-${++localCounter}`


      if (requestedId && widgetsRef.current.some((widget) => widget.id === requestedId)) return requestedId
      if (!canvas.addWidget(clampToVisibleWorld(point, w, h), id, title, kind)) {
        setCanvasNotice('Canvas is full — close a widget before adding another.')
        return null
      }
      return id
    },
    [canvas.addWidget, clampToVisibleWorld]
  )

  const createWidgetFromCommand = useCallback((kind: WidgetKind, initialCommand: string): void => {
    const cx = mainSize.w > 0 ? mainSize.w / 2 : window.innerWidth / 2
    const cy = mainSize.h > 0 ? mainSize.h / 2 : window.innerHeight / 2
    const center = toWorld(cx, cy)
    const defaults = WIDGET_DEFAULTS[kind]
    const id = placeWidget(kind, {
      x: center.x - defaults.w / 2,
      y: center.y - defaults.h / 2
    })
    if (id && kind === 'terminal' && initialCommand) queueInitialCommand(id, initialCommand)
  }, [mainSize.h, mainSize.w, placeWidget, toWorld])

  // A link opened with target=_blank or window.open() inside any <webview>
  // (main.ts denies the new window and rebroadcasts the URL instead — see
  // windowManager.ts) used to have no listener at all: the click did
  // nothing. This is the destination — open it the way a new browser tab
  // would, as a fresh browser widget seeded with the URL. The broadcast
  // isn't scoped to a widget id, so a new widget (rather than guessing
  // which existing one to target) is the only option that is always right.
  useEffect(() => {
    // The URL on this channel comes from a page inside a <webview>: any site
    // calling window.open() reaches here, and every arrival used to mint a
    // browser widget — a whole Chromium renderer process — with only the
    // main-process 350ms repeat guard and MAX_WIDGETS between a popup loop
    // and 200 of them, persisted to the canvas so they came back on restart.
    // A person opening links in quick succession stays well inside this;
    // anything faster is a script, and dropping those is what a popup blocker
    // is for.
    const openedAt: number[] = []
    const OPEN_WINDOW_MS = 5_000
    const MAX_OPENS_PER_WINDOW = 3
    return window.api.browser.onOpenTab((url) => {
      const now = Date.now()
      while (openedAt.length > 0 && now - openedAt[0] > OPEN_WINDOW_MS) openedAt.shift()
      if (openedAt.length >= MAX_OPENS_PER_WINDOW) {
        console.warn('suppressed a burst of window.open() calls from a browser widget', url)
        return
      }
      openedAt.push(now)

      const cx = mainSize.w > 0 ? mainSize.w / 2 : window.innerWidth / 2
      const cy = mainSize.h > 0 ? mainSize.h / 2 : window.innerHeight / 2
      const center = toWorld(cx, cy)
      const defaults = WIDGET_DEFAULTS.browser
      const id = placeWidget('browser', {
        x: center.x - defaults.w / 2,
        y: center.y - defaults.h / 2
      })
      if (!id) return
      try {
        localStorage.setItem(`orcspace-browser-url:${id}`, url)
      } catch {

      }
    })
  }, [mainSize.h, mainSize.w, placeWidget, toWorld])












  const onPickDir = useCallback((): void => {


    void window.api.workspace.pickDir().catch((err) => console.warn('workspace:pickDir failed', err))
  }, [])

  const terminalOptions = useMemo(
    () => widgets
      .filter((widget) => !widget.kind || widget.kind === 'terminal')
      .sort((a, b) => b.z - a.z)
      .map((widget) => ({ id: widget.id, title: widget.title || 'Terminal' })),
    [widgets]
  )

  const onSubmitCommand = useCallback((id: string, command: string, mode: 'command' | 'message'): void => {
    void window.api.terminal.write(id, mode === 'message' ? command : `${command}\r`).then((result) => {
      if (result && 'error' in result) setCanvasNotice(result.error)
    }).catch((error) => {
      setCanvasNotice(error instanceof Error ? error.message : String(error))
    })
  }, [])

  const onTargetTerminalChange = useCallback((id: string): void => {
    void updateSettings({ targetTerminalId: id || null })
  }, [updateSettings])









  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent, id: string): void => {
      const target = e.target as Element
      // preventDefault() on the second click suppresses the browser's
      // dblclick event, which makes the terminal consume the rename text.
      // Leave that click alone so the title's rename handler can run.
      if (target.matches('[data-testid="widget-title"]') && e.detail >= 2) return
      if (e.button !== 0 || !e.currentTarget.contains(e.target as Node) || editingRef.current === id ||
        target.closest('button, input, [role="menu"], [data-canvas-interactive]')) return
      // Keep the title's native click sequence intact so a double-click can
      // enter rename mode. The canvas is globally user-select:none, and the
      // pointer capture below still owns the drag stream.
      if (!target.matches('[data-testid="widget-title"]')) e.preventDefault()
      canvas.bringToFront(id)
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget || widget.maximized) return
      const startX = e.clientX
      const startY = e.clientY
      const { x: origX, y: origY } = widget
      const startZoom = cameraRef.current.zoom
      const header = e.currentTarget as HTMLElement
      const shell = header.parentElement
      let latestX = origX
      let latestY = origY
      let dragging = false
      const onMove = (ev: PointerEvent): void => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return
          dragging = true
          try { header.setPointerCapture(e.pointerId) } catch {}
        }
        const zoom = cameraRef.current.zoom || 1
        latestX = origX + (ev.clientX - startX) / startZoom
        latestY = Math.max(
          origY + (ev.clientY - startY) / startZoom,
          titleBarWorldY(cameraRef.current.y, zoom)
        )

        // Keep the pointer path on the compositor while the pointer is down.
        // Updating React state for every mouse packet forces the terminal and
        // any backdrop-filter layers to participate in layout before the next
        // frame. The final world position is committed once on release.
        if (shell?.isConnected) {
          shell.style.transform = `translate3d(${latestX - origX}px, ${latestY - origY}px, 0)`
          shell.style.willChange = 'transform'
        }
      }
      const onEnd = (): void => {
        if (!dragging) return
        canvas.updateWidget(id, { x: latestX, y: latestY })
        if (shell?.isConnected) {
          // Let the rAF-batched state update paint before removing the preview.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!shell.isConnected) return
              shell.style.transform = ''
              shell.style.willChange = ''
            })
          })
        }
        try {
          if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId)
        } catch {

        }
      }
      // Synthetic pointer events used by automation can have pointerId=0;
      // don't filter real mouse packets in that case.
      trackDrag(onMove, onEnd, e.pointerId > 0 ? e.pointerId : undefined)
    },
    [canvas.bringToFront, canvas.updateWidget]
  )

  const onResizeStart = useCallback(
    (e: React.PointerEvent, id: string, dir: ResizeDir): void => {
      e.preventDefault()
      e.stopPropagation()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {

      }
      canvas.bringToFront(id)
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget || widget.maximized) return

      const startX = e.clientX
      const startY = e.clientY
      const { x: ox, y: oy, w: ow, h: oh } = widget
      const startZoom = cameraRef.current.zoom
      const onMove = (ev: MouseEvent): void => {
        const dx = (ev.clientX - startX) / startZoom
        const dy = (ev.clientY - startY) / startZoom
        // Size first, position second. Deriving x/y from an unclamped size
        // and only then applying the kind's maximum left the anchored edge
        // travelling with the pointer after the size had stopped growing,
        // which slid the whole widget across the canvas.
        const { w, h } = clampWidgetSize(
          widget.kind,
          dir.includes('e') ? ow + dx : dir.includes('w') ? ow - dx : ow,
          dir.includes('s') ? oh + dy : dir.includes('n') ? oh - dy : oh
        )
        let x = dir.includes('w') ? ox + ow - w : ox
        let y = dir.includes('n') ? oy + oh - h : oy

        const minY = titleBarWorldY(cameraRef.current.y, cameraRef.current.zoom)
        if (y < minY) {
          const bottom = y + h
          y = minY
          canvas.updateWidget(id, { x, y, w, h: Math.max(MIN_H, bottom - y) })
          return
        }
        canvas.updateWidget(id, { x, y, w, h })
      }
      trackDrag(onMove, undefined, e.pointerId)
    },
    [canvas.bringToFront, canvas.updateWidget]
  )

  const onWidgetFocus = useCallback((id: string): void => canvas.bringToFront(id), [canvas.bringToFront])
  const cancelledEditRef = useRef<string | null>(null)
  const onStartEditing = useCallback((id: string): void => {
    cancelledEditRef.current = null
    setEditingId(id)
  }, [])
  const onRename = useCallback(
    (id: string, title: string): void => {
      if (cancelledEditRef.current === id) {
        cancelledEditRef.current = null
        return
      }
      canvas.updateWidget(id, { title })


      setEditingId((cur) => (cur === id ? null : cur))
    },
    [canvas.updateWidget]
  )
  const onCancelEditing = useCallback((id: string): void => {
    cancelledEditRef.current = id
    setEditingId((cur) => (cur === id ? null : cur))
  }, [])
  const onToggleMaximize = useCallback(
    (id: string): void => {
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget) return


      if (NON_MAXIMIZABLE.has((widget.kind ?? 'terminal') as WidgetKind)) return
      const next = !widget.maximized

      for (const other of widgetsRef.current) {
        if (other.id !== id && other.maximized) canvas.updateWidget(other.id, { maximized: false })
      }
      canvas.updateWidget(id, { maximized: next })
      canvas.bringToFront(id)
    },
    [canvas.updateWidget, canvas.bringToFront]
  )



  useEffect(() => {
    for (const w of widgets) {
      if (NON_MAXIMIZABLE.has((w.kind ?? 'terminal') as WidgetKind) && w.maximized) {
        canvas.updateWidget(w.id, { maximized: false })
      }
      if ((w.kind as string) === 'timer' && (w.w > 360 || w.h > 320)) {
        canvas.updateWidget(w.id, { w: Math.min(w.w, 360), h: Math.min(w.h, 320) })
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets.length])

  const onWidgetClose = useCallback(
    (id: string): void => {
      const widget = widgetsRef.current.find((w) => w.id === id)
      const kind = widget?.kind ?? 'terminal'
      if (kind === 'terminal') {
        void confirm('Close terminal? The running process will be terminated.', {
          danger: true,
          title: 'Close Terminal',
          confirmLabel: 'Close'
        }).then((ok) => {
          if (ok) closeWidget(id)
        })
        return
      }
      closeWidget(id)
    },
    [closeWidget, confirm]
  )




  const onFrameKey = useCallback(
    (e: React.KeyboardEvent, id: string): void => {
      if (e.target !== e.currentTarget) return
      const dirs: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      }
      const dir = dirs[e.key]
      if (!dir) {


        if (e.key === 'Escape') {
          const widget = widgetsRef.current.find((w) => w.id === id)
          const isTerminal = !widget?.kind || widget.kind === 'terminal'
          if (isTerminal) {
            const termEl = (e.currentTarget as HTMLElement).querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
            if (termEl) {
              e.preventDefault()
              e.stopPropagation()
              termEl.focus()
              void window.api.terminal.write(id, '\x1b').catch(() => {})
              return
            }
          }
          e.preventDefault()
          e.stopPropagation()
          mainRef.current?.focus()
          return
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          onWidgetClose(id)
          return
        }

        const widget = widgetsRef.current.find((w) => w.id === id)
        const isTerminal = !widget?.kind || widget.kind === 'terminal'
        if (isTerminal && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
          const termEl = (e.currentTarget as HTMLElement).querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          if (termEl) {
            termEl.focus()
          }
        }
        return
      }
      const step = e.shiftKey ? 16 : 1
      e.preventDefault()
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget || widget.maximized) return
      const [dx, dy] = dir
      if (e.altKey) {


        // Same ordering rule as the pointer path above: clamp the size, then
        // place the edges the keystroke is not moving.
        const { w: width, h: height } = clampWidgetSize(
          widget.kind,
          widget.w + dx * step,
          widget.h + dy * step
        )
        let x = dx < 0 ? widget.x + widget.w - width : widget.x
        let y = dy < 0 ? widget.y + widget.h - height : widget.y
        const minY = titleBarWorldY(cameraRef.current.y, cameraRef.current.zoom)
        if (y < minY) {
          const bottom = y + height
          y = minY
          canvas.updateWidget(id, { x, y, w: width, h: Math.max(MIN_H, bottom - y) })
          return
        }
        canvas.updateWidget(id, { x, y, w: width, h: height })
      } else {
        canvas.updateWidget(id, {
          x: widget.x + dx * step,
          y: Math.max(widget.y + dy * step, titleBarWorldY(cameraRef.current.y, cameraRef.current.zoom))
        })
      }
    },
    [canvas.bringToFront, canvas.updateWidget, onWidgetClose]
  )



  const onCanvasKey = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget) return
    handleCanvasShortcut(e)
  }




  const handleCanvasShortcut = (e: KeyboardEvent | React.KeyboardEvent<HTMLElement>): void => {
    const target = e.target as HTMLElement | null
    if (
      target &&
      target !== mainRef.current &&
      target.closest(
        'input,textarea,select,button,[role="button"],[contenteditable="true"],.widget,.xterm,.term-shell,.rail,[role="dialog"],[role="menu"]'
      )
    ) return
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    }
    const dir = dirs[e.key]
    if (!dir) {

      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        setCamera((c) => ({ ...c, zoom: Math.min(4, c.zoom * 1.2) }))
        return
      }
      if (e.key === '-') {
        e.preventDefault()
        setCamera((c) => ({ ...c, zoom: Math.max(0.2, c.zoom / 1.2) }))
        return
      }
      if (e.key === '0') {
        e.preventDefault()
        setCamera({ x: 0, y: 0, zoom: 1 })
        return
      }

      if (e.key === 'Home') {
        e.preventDefault()
        setCamera({ x: 0, y: 0, zoom: 1 })
        return
      }
      return
    }
    e.preventDefault()
    const step = e.shiftKey ? 10 : 50
    setCamera((c) => ({ ...c, x: c.x - dir[0] * step, y: c.y - dir[1] * step }))
  }

  useEffect(() => {
    if (!active) return
    const onWindowKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      handleCanvasShortcut(event)
    }
    window.addEventListener('keydown', onWindowKey)
    return () => window.removeEventListener('keydown', onWindowKey)
  }, [active, camera.zoom])

  const onCanvasPointerDown = (e: React.PointerEvent): void => {
    if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return



    if (
      (e.target as HTMLElement).closest(
        '.widget, .rail, [role="menu"], [data-canvas-scroll-lock], [data-canvas-interactive]'
      )
    ) return

    if (tool === 'draw' && e.button === 0) {
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      let strokeId: string | null = null
      trackDrag(
        (ev) => {
          if (!moved) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAW_CLICK_THRESHOLD_PX) return
            moved = true
            strokeId = canvas.beginStroke(toWorld(startX, startY))
          }
          if (strokeId) canvas.extendStroke(strokeId, toWorld(ev.clientX, ev.clientY))
        },
        () => {


          if (!moved && strokeId) canvas.discardStroke(strokeId)
        }
      )
      return
    }

    if (tool === 'erase' && e.button === 0) {
      e.preventDefault()
      canvas.eraseAt(toWorld(e.clientX, e.clientY))
      trackDrag((ev) => canvas.eraseAt(toWorld(ev.clientX, ev.clientY)))
      return
    }



    const wantsPan = tool === 'pan' ? e.button === 0 : e.button === 1 || (e.button === 0 && e.shiftKey)
    if (!wantsPan) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const origin = camera
    setIsPanning(true)






    trackDrag(
      (ev) => {
        panPendingRef.current = { ...origin, x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY }
        if (panRafRef.current === null) {
          panRafRef.current = requestAnimationFrame(() => {
            panRafRef.current = null
            if (panPendingRef.current) {
              setCamera(panPendingRef.current)
              panPendingRef.current = null
            }
          })
        }
      },
      () => {
        setIsPanning(false)
        if (panRafRef.current !== null) {
          cancelAnimationFrame(panRafRef.current)
          panRafRef.current = null
        }
        if (panPendingRef.current) {
          setCamera(panPendingRef.current)
          panPendingRef.current = null
        }
      }
    )
  }







  const wheelStepsRef = useRef<Array<{ kind: 'pan'; dx: number; dy: number } | { kind: 'zoom'; sx: number; sy: number; deltaY: number }>>([])
  const wheelRafRef = useRef<number | null>(null)

  const flushWheel = useCallback((): void => {
    wheelRafRef.current = null
    const steps = wheelStepsRef.current
    wheelStepsRef.current = []
    if (steps.length === 0) return

    setCamera((c) => {
      let next = c
      for (const s of steps) {
        if (s.kind === 'pan') {
          next = { ...next, x: next.x - s.dx, y: next.y - s.dy }
        } else {
          const factor = Math.exp(-s.deltaY * 0.001)
          const zoom = clamp(next.zoom * factor, 0.2, 4)
          next = {
            zoom,
            x: s.sx - ((s.sx - next.x) / next.zoom) * zoom,
            y: s.sy - ((s.sy - next.y) / next.zoom) * zoom
          }
        }
      }
      return next
    })
  }, [setCamera])





  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent): void => {


      if (
        (e.target as HTMLElement).closest(
          '.widget, .widget-shell, .widget-body, [data-canvas-scroll-lock], .rail, [role="dialog"], [role="alertdialog"], [role="menu"], input, textarea, select, .xterm, .term-shell, .term'
        )
      ) {
        return
      }
      e.preventDefault()

      const sx = e.clientX - mainOffsetRef.current.left
      const sy = e.clientY - mainOffsetRef.current.top

      if (e.ctrlKey || e.metaKey) {
        wheelStepsRef.current.push({ kind: 'zoom', sx, sy, deltaY: e.deltaY })
      } else {
        wheelStepsRef.current.push({ kind: 'pan', dx: e.deltaX, dy: e.deltaY })
      }
      if (wheelRafRef.current === null) {
        wheelRafRef.current = requestAnimationFrame(flushWheel)
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', handleWheel)
      if (wheelRafRef.current !== null) {
        cancelAnimationFrame(wheelRafRef.current)
        wheelRafRef.current = null
      }
    }
  }, [flushWheel])

  useEffect(() => {
    return () => {
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current)
    }
  }, [])

  useEffect(() => {
    const onGlobalDragOver = (e: DragEvent): void => {
      e.preventDefault()
    }
    const onGlobalDrop = (e: DragEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('dragover', onGlobalDragOver)
    window.addEventListener('drop', onGlobalDrop)
    return () => {
      window.removeEventListener('dragover', onGlobalDragOver)
      window.removeEventListener('drop', onGlobalDrop)
    }
  }, [])

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if ((e.target as HTMLElement).closest('.widget, .rail, [data-canvas-scroll-lock]')) return
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const onCanvasDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
  }

  const deliverWhenMounted = useCallback(
    (widgetId: string, deliver: () => void, onDelivered: () => void, onFailed: () => void): void => {
      let attempts = 0
      const timer = window.setInterval(() => {
        attempts += 1
        if (widgetsRef.current.some((w) => w.id === widgetId)) {
          window.clearInterval(timer)
          deliver()
          onDelivered()
        } else if (attempts >= 10) {
          window.clearInterval(timer)
          onFailed()
        }
      }, 100)
    },
    []
  )

  // `orc canvas image <path>` places the browser widget from the main process
  // and then sends the file here. The widget is created through the same
  // control:add-widget round trip as a terminal, so it is not mounted yet when
  // this arrives — deliverWhenMounted is what a drop onto the canvas uses for
  // exactly the same reason.
  useEffect(() => {
    return window.api.control.onOpenMedia(({ widgetId, path, name, mediaUrl, kind }) => {
      deliverWhenMounted(
        widgetId,
        () => window.dispatchEvent(new CustomEvent('orcspace:open-media', {
          detail: { widgetId, path, name, mediaUrl, kind }
        })),
        () => setCanvasNotice(`Opened "${name}"`),
        () => setCanvasNotice(`Failed to open "${name}"`)
      )
    })
  }, [deliverWhenMounted])

  const onCanvasDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    if (!e.dataTransfer || !e.dataTransfer.files.length) return

    const dropPoint = toWorld(e.clientX, e.clientY)
    const shortName = (name: string): string => (name.length > 80 ? `${name.slice(0, 77)}…` : name)
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : file.type.split('/')[1] || 'bin'
      const isAudio = file.type.startsWith('audio/') || /^(mp3|wav|ogg|oga|flac|aac|m4a|opus|weba|wma)$/i.test(ext)
      const isVideo = file.type.startsWith('video/') || /^(mp4|m4v|webm|mkv|mov|avi|wmv|flv|ogv|mpg|mpeg)$/i.test(ext)
      const isImage = file.type.startsWith('image/') || /^(png|jpe?g|gif|webp|avif|bmp|svg|ico|tif|tiff|heic)$/i.test(ext)
      const isPdf = ext === 'pdf' || file.type === 'application/pdf'
      const isTextDoc = /^(txt|md|markdown|json|csv|tsv|yaml|yml|xml|html?|log|js|ts|jsx|tsx|py|sh|bat|cmd|ps1)$/i.test(ext)
      const mediaKind = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : isPdf ? 'pdf' : isTextDoc ? 'text' : 'doc'

      try {
        const arrayBuffer = await file.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        const saved = await window.api.media.saveBytes(bytes, ext)
        if (saved && 'error' in saved) {
          setCanvasNotice(`Failed to save file: ${saved.error}`)
          continue
        }
        if (saved && 'path' in saved) {
          if (isAudio) {
            const existingPlayer = widgetsRef.current.find((w) => w.kind === 'music-player')
            const track = {
              id: crypto.randomUUID(),
              url: `orc://media/${saved.name}`,
              title: file.name.replace(/\.[a-z0-9]+$/i, ''),
              provider: 'audio' as const
            }
            if (existingPlayer) {
              window.dispatchEvent(new CustomEvent('orcspace:add-music-track', {
                detail: { widgetId: existingPlayer.id, track }
              }))
              setCanvasNotice(`Added "${shortName(file.name)}" to music player`)
            } else {
              const widgetId = placeWidget('music-player', dropPoint)
              if (widgetId) {
                deliverWhenMounted(
                  widgetId,
                  () => window.dispatchEvent(new CustomEvent('orcspace:add-music-track', {
                    detail: { widgetId, track }
                  })),
                  () => setCanvasNotice(`Added "${shortName(file.name)}" to music player`),
                  () => setCanvasNotice(`Failed to open "${shortName(file.name)}"`)
                )
              }
            }
          } else {
            const widgetId = placeWidget('browser', dropPoint)
            if (widgetId) {
              const mediaUrl = `orc://media/${saved.name}`
              const kind = mediaKind
              deliverWhenMounted(
                widgetId,
                () => window.dispatchEvent(new CustomEvent('orcspace:open-media', {
                  detail: { widgetId, path: saved.path, name: file.name, mediaUrl, kind }
                })),
                () => setCanvasNotice(`Opened "${shortName(file.name)}"`),
                () => setCanvasNotice(`Failed to open "${shortName(file.name)}"`)
              )
            }
          }
        }
      } catch (err) {
        console.error('Failed to handle dropped file:', err)
        setCanvasNotice(`Failed to open file: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

















  const renderableWidgets = useMemo(() => {
    if (!mainSize.w || !mainSize.h) return widgets
    const zoom = camera.zoom || 1
    // Culling a terminal unmounts it, and unmounting disposes its xterm and
    // detaches from the pty — coming back re-runs the whole connect: a
    // "Connecting…" overlay, stdin disabled, and up to 512KB of scrollback
    // replayed slice by slice. At one screen of margin an ordinary pan across
    // the canvas was enough to trigger that on every terminal it passed. The
    // widgets are memoised, so keeping more of them mounted is far cheaper
    // than rebuilding one.
    const margin = 3
    const minX = (-margin * mainSize.w - camera.x) / zoom
    const minY = (-margin * mainSize.h - camera.y) / zoom
    const maxX = ((1 + margin) * mainSize.w - camera.x) / zoom
    const maxY = ((1 + margin) * mainSize.h - camera.y) / zoom
    return widgets.filter((w) => {
      if (w.maximized) return true
      if ((w.kind ?? 'terminal') !== 'terminal') return true
      return w.x + w.w >= minX && w.x <= maxX && w.y + w.h >= minY && w.y <= maxY
    })
  }, [widgets, camera.x, camera.y, camera.zoom, mainSize.w, mainSize.h])







  const worldTransform = useMemo(
    () => ({
      transform: `translate3d(${camera.x}px, ${camera.y}px, 0px) scale(${camera.zoom})`,
      willChange: 'transform'
    }),
    [camera.x, camera.y, camera.zoom]
  )





  // Keep every widget under one React parent while maximizing. Moving a
  // terminal between the world and overlay trees destroys xterm and forces a
  // PTY reconnect; moving a webview does the same to its guest process. The
  // maximized geometry below is expressed in world coordinates so the
  // existing camera transform still lands it on the app viewport.
  const widgetStyles = useMemo(() => {
    const styles = new Map<string, React.CSSProperties>()
    for (const widget of renderableWidgets) {
      if (widget.maximized) {
        const zoom = camera.zoom || 1
        styles.set(widget.id, {
          left: -camera.x / zoom,
          top: (TITLE_BAR_HEIGHT - camera.y) / zoom,
          width: mainSize.w / zoom,
          height: Math.max(0, mainSize.h - TITLE_BAR_HEIGHT) / zoom,
          zIndex: 200
        })
        continue
      }
      styles.set(widget.id, {
        left: widget.x,
        top: widget.y,
        width: widget.w,
        height: widget.h,
        zIndex: widget.z
      })
    }
    return styles
  }, [renderableWidgets, camera.x, camera.y, camera.zoom, mainSize.w, mainSize.h])





  const handlerCacheRef = useRef<Map<string, {
    onHeaderPointerDown: (e: React.PointerEvent) => void
    onResizeStart: (e: React.PointerEvent, dir: ResizeDir) => void
    onFocus: () => void
    onStartEditing: () => void
    onRename: (title: string) => void
    onCancelEditing: () => void
    onToggleMaximize: () => void
    onClose: () => void
    onProcessExit: () => void
    onKeyDown: (e: React.KeyboardEvent) => void
  }>>(new Map())

  const widgetHandlers = (id: string) => {
    let handlers = handlerCacheRef.current.get(id)
    if (!handlers) {
      handlers = {
        onHeaderPointerDown: (e: React.PointerEvent) => onHeaderPointerDown(e, id),
        onResizeStart: (e: React.PointerEvent, dir: ResizeDir) => onResizeStart(e, id, dir),
        onFocus: () => onWidgetFocus(id),
        onStartEditing: () => onStartEditing(id),
        onRename: (title: string) => onRename(id, title),
        onCancelEditing: () => onCancelEditing(id),
        onToggleMaximize: () => onToggleMaximize(id),
        onClose: () => onWidgetClose(id),
        onProcessExit: () => closeWidget(id),
        onKeyDown: (e: React.KeyboardEvent) => onFrameKey(e, id)
      }
      handlerCacheRef.current.set(id, handlers)
    }
    return handlers
  }






  useEffect(() => {
    const cache = handlerCacheRef.current
    if (cache.size === 0) return
    const live = new Set(widgets.map((w) => w.id))
    for (const id of Array.from(cache.keys())) {
      if (!live.has(id)) cache.delete(id)
    }
  }, [widgets])

  return (
    <div className="relative flex flex-1 overflow-hidden">
      {activeView !== 'canvas' && !codeSidebarCollapsed && (
        <Sidebar
          workspaceDir={workspaceDir}
          activeView={activeView}
          onPickDir={onPickDir}
        />
      )}
      <div className={active ? 'contents' : 'contents invisible pointer-events-none'} aria-hidden={!active} inert={!active}>
          <main
          ref={mainRef}
          data-testid="canvas"
          className="canvas-area relative flex-1 overflow-hidden pt-10 select-none outline-none focus:outline-none"
          tabIndex={0}
          onPointerDown={onCanvasPointerDown}
          onContextMenu={onContextMenu}
          onKeyDown={onCanvasKey}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
          style={{



            touchAction: 'none',
            contain: 'layout style',
            cursor: isPanning
              ? 'grabbing'
              : tool === 'pan'
                ? 'grab'
                : tool === 'draw' || tool === 'erase'
                  ? 'crosshair'
                  : 'default'
          }}
        >
        <div
          className="absolute inset-0 h-px w-px origin-top-left"
          style={worldTransform}
        >
          {

}
          <ConnectionsLayer connections={connections} widgets={widgets} />
        </div>
        <StrokesLayer strokes={strokes} camera={camera} width={mainSize.w} height={mainSize.h} />
          {widgets.length === 0 && strokes.length === 0 && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
            aria-label="Empty canvas"
            role="status"
          >
            <div className="rounded-[14px] border border-line-soft bg-bg-panel/80 px-6 py-5 text-center shadow-xl backdrop-blur-md">
              <div className="mb-1 text-sm font-medium text-text">Your canvas is clear</div>
              <div className="mb-3 text-[11px] text-text-faint">Use the command bar below: /terminal, .files, @planner, or plain terminal</div>
              <button
                type="button"
                className="pointer-events-auto rounded-[8px] bg-accent px-3 py-1.5 text-[11px] font-medium text-bg hover:opacity-90"
                onClick={() => {
                  const cx = mainSize.w > 0 ? mainSize.w / 2 : window.innerWidth / 2
                  const cy = mainSize.h > 0 ? mainSize.h / 2 : window.innerHeight / 2
                  const halfW = WIDGET_W / 2
                  const halfH = WIDGET_H / 2
                  const center = toWorld(cx, cy)
                  const world = { x: center.x - halfW, y: center.y - halfH }
                  const clamped = clampToVisibleWorld(world, WIDGET_W, WIDGET_H)
                  if (!canvas.addWidget(clamped)) {
                    setCanvasNotice('Canvas is full — close a widget before adding another.')
                  }
                }}
              >
                Add terminal
              </button>
              <div className="mt-2 text-[10px] text-text-faint">
                <kbd className="rounded border border-line px-1 py-0.5 text-[9px] text-text-dim">T</kbd>{' '}
                <kbd className="rounded border border-line px-1 py-0.5 text-[9px] text-text-dim">N</kbd>{' '}
                <kbd className="rounded border border-line px-1 py-0.5 text-[9px] text-text-dim">+</kbd>{' '}
                <kbd className="rounded border border-line px-1 py-0.5 text-[9px] text-text-dim">-</kbd>{' '}
                <kbd className="rounded border border-line px-1 py-0.5 text-[9px] text-text-dim">0</kbd>{' '}
                <kbd className="rounded border border-line px-1 py-0.5 text-[9px] text-text-dim">Home</kbd>
              </div>
            </div>
          </div>
        )}
        {
}
        <div className="absolute inset-0 h-px w-px origin-top-left" style={worldTransform}>
          {renderableWidgets.map((w) => (
            <WidgetFrame
              key={w.id}
              widget={w}
              active={w.z === topZ.current}
              editing={editingId === w.id}
              style={widgetStyles.get(w.id)!}
              {...widgetHandlers(w.id)}
              workspaceDir={workspaceDir}
            />
          ))}
        </div>
        {
}
        {canvasNotice && (
          <div role="status" className="pointer-events-none absolute bottom-20 left-1/2 z-[300] -translate-x-1/2 rounded-[10px] border border-line bg-bg-panel/95 px-3 py-1.5 text-[11px] text-text shadow-lg">
            {canvasNotice}
          </div>
        )}
        {menu && (
          <ContextMenu
            at={menu}
            onPickTerminal={() => {
              placeWidget('terminal', toWorld(menu.x, menu.y))
              setMenu(null)
            }}
            onPickFiles={() => { placeWidget('files', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickSysMonitor={() => { placeWidget('sys-monitor', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickTimer={() => { placeWidget('timer', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickPlanner={() => { placeWidget('planner', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickOrchestration={() => { placeWidget('orchestration', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickBrowser={() => { placeWidget('browser', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickLinks={() => { placeWidget('links', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickMusicPlayer={() => { placeWidget('music-player', toWorld(menu.x, menu.y)); setMenu(null) }}
            favoriteWidgets={settings.favoriteWidgets ?? []}
            onClose={() => setMenu(null)}
          />
        )}
      </main>

      <Toolbar
        tool={tool}
        onToolChange={setTool}
        hasStrokes={strokes.length > 0}
        onClearStrokes={() => {
          void confirm('Erase entire drawing? This action cannot be undone.', { danger: true, confirmLabel: 'Erase' }).then(
            (ok) => ok && canvas.clearStrokes()
          )
        }}
        strokeColor={strokeColor}
        onStrokeColorChange={setStrokeColor}
        workspaceDir={workspaceDir}
        onPickDir={onPickDir}
        terminals={terminalOptions}
        targetTerminalId={settings.targetTerminalId}
        commandPrefix={settings.commandPrefix}
        onTargetTerminalChange={onTargetTerminalChange}
        onCreateWidget={createWidgetFromCommand}
        onSubmitCommand={onSubmitCommand}
      />
      </div>
    </div>
  )
}







function trackDrag(onMove: (e: PointerEvent) => void, onEnd?: () => void, pointerId?: number): void {
  let released = false
  document.body.classList.add('is-dragging')
  const release = (): void => {
    if (released) return
    released = true
    document.body.classList.remove('is-dragging')
    window.removeEventListener('pointermove', move)
    // `up` (not `release`) is what was registered: removing the wrong
    // reference left one dead pointerup listener on window per drag — every
    // widget move, canvas pan and pen stroke — for the life of the session.
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    window.removeEventListener('blur', release)
    onEnd?.()
  }
  const move = (event: PointerEvent): void => {
    if (pointerId !== undefined && event.pointerId !== pointerId) return
    if (event.buttons === 0) { release(); return }
    onMove(event)
  }
  const up = (event: PointerEvent): void => {
    if (pointerId !== undefined && event.pointerId !== pointerId) return
    release()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  window.addEventListener('blur', release)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}








