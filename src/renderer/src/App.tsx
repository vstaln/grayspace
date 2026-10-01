import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar, { SettingsModal } from './components/Sidebar'
import WidgetFrame, { forgetAgentSelection } from './components/WidgetFrame'
import { forgetTerminalViewport } from './components/TerminalWidget'
import { clearInitialCommand } from './lib/pendingTerminalCommands'
import ContextMenu from './components/ContextMenu'
import TitleBar from './components/TitleBar'
import type { WorkView } from './components/TitleBar'
import { useCanvas } from './hooks/useCanvas'
import { Camera, clampWidgetSize, type Widget, MIN_H, NON_MAXIMIZABLE, Point, ResizeDir, WidgetKind, WIDGET_DEFAULTS, WIDGET_H, WIDGET_W } from './types'
import ErrorBoundary from './components/ErrorBoundary'
import StrokesLayer from './components/StrokesLayer'
import ConnectionsLayer from './components/ConnectionsLayer'
import { ThemeProvider, useTheme, wallpaperBackgroundImage } from './theme'
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog'
import { useSettings } from './hooks/useSettings'
import { useAutoApprovePermissions } from './hooks/useAutoApprovePermissions'
import { DRAW_CLICK_THRESHOLD_PX } from './lib/canvasMetrics'
import { arrangeWidgets, isArrangeMode, type ArrangeMode } from './lib/canvasLayout'
import { isCodeLayoutMode, type CodeLayoutMode } from './lib/codeLayout'
import { ToastContainer, usePersistErrorToasts, useTerminalBackendErrorToasts, useToasts } from './components/Toast'
import Toolbar from './components/Toolbar'
import StatusBar from './components/StatusBar'
import { queueInitialCommand } from './lib/pendingTerminalCommands'
import { fitCameraToRect, zoomCameraAt, zoomCameraBy } from './lib/canvasCamera'
import {
  ZOOM_BASELINE_SAVE_DELAY_MS,
  ZOOM_BASELINE_STORAGE_KEY,
  adaptCanvasZoom,
  parseZoomBaseline,
  serializeZoomBaseline,
  type ZoomAdaptationState
} from './lib/responsiveCanvasZoom'
import { DEFAULT_IMAGE_INSERT_SHORTCUT, matchesShortcut } from './lib/keyboardShortcut'
import { isBrowserMounted, isCodeBrowserGuest } from './lib/mountedBrowsers'



const CodeView = lazy(() => import('./components/CodeView'))


let localCounter = 0



const TITLE_BAR_HEIGHT = 40

const ARRANGE_MODE_KEY = 'orcspace-arrange-mode'

/** Height of the floating canvas tool bar plus its bottom margin. */
const TOOLBAR_RESERVE_PX = 88

const FREE_LAYOUT_KEY = 'orcspace-arrange-free-layout'

const CODE_LAYOUT_KEY = 'orcspace-code-layout-mode'
const FLIP_TERMINALS_KEY = 'orcspace-flip-terminals'

type FreeLayoutEntry = Pick<Widget, 'x' | 'y' | 'w' | 'h'> & { maximized?: boolean }

/**
 * The pre-arrange geometry outlives the session: widget positions are
 * persisted, so a reload that comes back tiled must still be able to go Free.
 */
function readFreeLayout(): Map<string, FreeLayoutEntry> | null {
  try {
    const raw = localStorage.getItem(FREE_LAYOUT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, Partial<FreeLayoutEntry>>
    const entries = Object.entries(parsed).filter(
      ([, v]) =>
        typeof v?.x === 'number' && typeof v?.y === 'number' &&
        typeof v?.w === 'number' && typeof v?.h === 'number'
    )
    return entries.length > 0
      ? new Map(entries.map(([id, v]) => [id, v as FreeLayoutEntry]))
      : null
  } catch {
    return null
  }
}

function writeFreeLayout(layout: Map<string, FreeLayoutEntry> | null): void {
  try {
    if (!layout) localStorage.removeItem(FREE_LAYOUT_KEY)
    else localStorage.setItem(FREE_LAYOUT_KEY, JSON.stringify(Object.fromEntries(layout)))
  } catch {}
}

function titleBarWorldY(cameraY: number, zoom: number): number {
  return (TITLE_BAR_HEIGHT - cameraY) / (zoom || 1)
}

export default function App(): React.JSX.Element {




  const [activeView, setActiveView] = useState<WorkView>('canvas')
  const activeViewRef = useRef<WorkView>(activeView)
  activeViewRef.current = activeView
  const [canvasHistory, setCanvasHistory] = useState({ canUndo: false, canRedo: false })
  const [codeSidebarCollapsed, setCodeSidebarCollapsed] = useState(false)
  const [terminalsFlipped, setTerminalsFlipped] = useState(() => {
    try { return localStorage.getItem(FLIP_TERMINALS_KEY) === 'true' } catch { return false }
  })
  const toggleCodeSidebar = useCallback(() => setCodeSidebarCollapsed((collapsed) => !collapsed), [])
  const toggleTerminalsFlipped = useCallback(() => {
    setTerminalsFlipped((flipped) => {
      const next = !flipped
      try { localStorage.setItem(FLIP_TERMINALS_KEY, String(next)) } catch {}
      return next
    })
  }, [])

  useEffect(() => {
    const onHistory = (event: Event): void => {
      const detail = (event as CustomEvent<{ canUndo?: boolean; canRedo?: boolean }>).detail
      setCanvasHistory({ canUndo: detail?.canUndo === true, canRedo: detail?.canRedo === true })
    }
    window.addEventListener('orcspace:canvas-history', onHistory)
    return () => window.removeEventListener('orcspace:canvas-history', onHistory)
  }, [])

  const undoCanvas = useCallback(() => window.dispatchEvent(new Event('orcspace:canvas-undo')), [])
  const redoCanvas = useCallback(() => window.dispatchEvent(new Event('orcspace:canvas-redo')), [])

  const [arrangeMode, setArrangeMode] = useState<ArrangeMode>(() => {
    try {
      const saved = localStorage.getItem(ARRANGE_MODE_KEY)
      // Without the pre-arrange snapshot there is nothing for Free to restore,
      // so an arranged mode with no snapshot would tick a menu item that does
      // nothing. Fall back to Free rather than lie about the state.
      if (isArrangeMode(saved) && (saved === 'free' || readFreeLayout() !== null)) return saved
    } catch {}
    return 'free'
  })
  const [codeLayoutMode, setCodeLayoutMode] = useState<CodeLayoutMode>(() => {
    try {
      const saved = localStorage.getItem(CODE_LAYOUT_KEY)
      if (isCodeLayoutMode(saved)) return saved
    } catch {}
    return 'auto'
  })
  // Unlike the canvas, Code re-derives its grid from the mode on every render,
  // so the mode is the whole state — there is no snapshot to restore.
  const setCodeLayout = useCallback((mode: CodeLayoutMode): void => {
    setCodeLayoutMode(mode)
    try {
      localStorage.setItem(CODE_LAYOUT_KEY, mode)
    } catch {}
  }, [])

  const arrangeCanvas = useCallback((mode: ArrangeMode): void => {
    setArrangeMode(mode)
    try {
      localStorage.setItem(ARRANGE_MODE_KEY, mode)
    } catch {}
    window.dispatchEvent(new CustomEvent('orcspace:canvas-arrange', { detail: { mode } }))
  }, [])


  const [codeStarted, setCodeStarted] = useState(false)
  const codeWorkspaceIdRef = useRef('code-default')
  const codeWorkspaceFolderRef = useRef<string | null>(null)
  const workspaceViewLoadRef = useRef(0)




  useEffect(() => {
    let mounted = true
    const restoreWorkspaceView = (workspaceId: string, preserveCurrentView = false): void => {
      const request = ++workspaceViewLoadRef.current
      void window.api.code.load().then((snap) => {
        if (!mounted || request !== workspaceViewLoadRef.current || codeWorkspaceIdRef.current !== workspaceId) return
        if ((snap?.sessions ?? []).length > 0) setCodeStarted(true)
        const av = (snap as unknown as { activeView?: string } | null | undefined)?.activeView ?? null

        if (preserveCurrentView) return
        if (av === 'code') {
          setCodeStarted(true)
          setActiveView('code')
        } else if (av === 'overview') {
          setActiveView('overview')
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
      const nextFolder = state?.folder ?? null
      const folderClosedWhileInCode =
        codeWorkspaceFolderRef.current !== null &&
        nextFolder === null &&
        activeViewRef.current === 'code'
      const scopeChanged =
        codeWorkspaceIdRef.current !== (state?.activeId ?? 'code-default') ||
        codeWorkspaceFolderRef.current !== nextFolder
      codeWorkspaceIdRef.current = state?.activeId ?? 'code-default'
      codeWorkspaceFolderRef.current = nextFolder
      // Renaming a workspace changes its label, not the saved view slot.
      if (scopeChanged) restoreWorkspaceView(codeWorkspaceIdRef.current, folderClosedWhileInCode)
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
  const { settings: appSettings } = useSettings()
  useAutoApprovePermissions(appSettings.autoApprovePermissions ?? false)

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
              arrangeMode={arrangeMode}
              onArrange={arrangeCanvas}
              codeLayoutMode={codeLayoutMode}
              onCodeLayout={setCodeLayout}
              canUndo={canvasHistory.canUndo}
              canRedo={canvasHistory.canRedo}
              onUndo={undoCanvas}
              onRedo={redoCanvas}
              terminalsFlipped={terminalsFlipped}
              onToggleTerminalsFlipped={toggleTerminalsFlipped}
            />
            <SettingsModal listenForToolbar />
            <div className="flex flex-1 flex-col">
              <ErrorBoundary>
                <OrcSpaceCanvas
                  active={activeView === 'canvas'}
                  activeView={activeView}
                  codeSidebarCollapsed={codeSidebarCollapsed}
                  terminalsFlipped={terminalsFlipped}
                />
              </ErrorBoundary>
            </div>
            {codeStarted && (
              <ErrorBoundary>
                <Suspense fallback={<div role="status" className="grid h-full place-items-center text-text-dim">Loading…</div>}>
                  <CodeView active={activeView === 'code'} layoutMode={codeLayoutMode} sidebarCollapsed={codeSidebarCollapsed} terminalsFlipped={terminalsFlipped} />
                </Suspense>
              </ErrorBoundary>
            )}
            <ToastContainer toasts={toasts} onDismiss={dismiss} />
            <StatusBar />
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
            className="pointer-events-auto rounded-panel border border-line bg-bg-panel/90 px-3 py-1.5 text-[11px] text-text-dim shadow-sm hover:bg-bg-hover hover:text-text"
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
  codeSidebarCollapsed,
  terminalsFlipped
}: {
  active: boolean
  activeView: WorkView
  codeSidebarCollapsed: boolean
  terminalsFlipped: boolean
}): React.JSX.Element {
  const { settings, update: updateSettings } = useSettings()
  const canvas = useCanvas({ favoriteTerminalNames: settings.favoriteTerminalNames })
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
  const mainSizeRef = useRef(mainSize)
  mainSizeRef.current = mainSize
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
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const canvasZoomAnchor = useCallback((): Point => {
    const { w, h } = mainSizeRef.current
    return {
      x: w > 0 ? w / 2 : window.innerWidth / 2,
      y: h > 0 ? h / 2 : window.innerHeight / 2
    }
  }, [])

  /**
   * Keeps the canvas scaled to the window.
   *
   * The baseline is the zoom the user last chose and the window size they
   * chose it at; the displayed zoom is always that baseline rescaled by how
   * much of the window is left. Recomputing from the baseline rather than
   * compounding is what makes shrinking reversible — grow the window back and
   * the zoom lands on exactly the value it started from, with every widget's
   * stored geometry untouched throughout.
   *
   * Telling the user's zoom apart from this effect's own is done by
   * remembering what it last applied: any zoom that is not that value came
   * from somewhere else — a wheel, a button, Fit, or a workspace being
   * hydrated — and becomes the new baseline. That rule needs no cooperation
   * from the places that set the camera, so a new one cannot forget to
   * participate.
   */
  const zoomAdaptationRef = useRef<ZoomAdaptationState | null | undefined>(undefined)
  // Debounced, because every `orcspace:` key that localStorage takes is also
  // mirrored to the main process over IPC (see durableLocalStorage). Writing
  // on each step of a window drag would have sent one round trip per resize
  // event; only where the drag comes to rest is worth persisting.
  const zoomBaselineSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (zoomBaselineSaveRef.current !== null) clearTimeout(zoomBaselineSaveRef.current)
  }, [])
  const saveZoomBaseline = useCallback((state: ZoomAdaptationState): void => {
    if (zoomBaselineSaveRef.current !== null) clearTimeout(zoomBaselineSaveRef.current)
    zoomBaselineSaveRef.current = setTimeout(() => {
      zoomBaselineSaveRef.current = null
      try {
        localStorage.setItem(ZOOM_BASELINE_STORAGE_KEY, serializeZoomBaseline(state))
      } catch {
        // Private mode or a full quota: the adaptation still works for this run.
      }
    }, ZOOM_BASELINE_SAVE_DELAY_MS)
  }, [])
  useEffect(() => {
    if (zoomAdaptationRef.current === undefined) {
      // Restored, not re-derived: the camera loaded from disk carries the
      // *adapted* zoom, so without the baseline that produced it the previous
      // session's shrink would become this session's 100%.
      try {
        zoomAdaptationRef.current = parseZoomBaseline(localStorage.getItem(ZOOM_BASELINE_STORAGE_KEY))
      } catch {
        zoomAdaptationRef.current = null
      }
    }
    const viewport = { w: mainSize.w, h: mainSize.h }
    const step = adaptCanvasZoom(zoomAdaptationRef.current, camera.zoom, viewport)
    if (step.kind === 'idle') return
    zoomAdaptationRef.current = step.state
    saveZoomBaseline(step.state)
    if (step.kind === 'rebaseline') return
    // Anchored at the middle of the viewport so the widget the user was
    // looking at stays where they were looking. Same anchor the zoom buttons
    // use, so a resize and a zoom click agree on what "the middle" is.
    setCamera((c) => zoomCameraAt(c, step.zoom, canvasZoomAnchor()))
  }, [mainSize.w, mainSize.h, camera.zoom, setCamera, canvasZoomAnchor, saveZoomBaseline])
  const onZoomIn = useCallback(() => {
    setCamera((c) => zoomCameraBy(c, 1, canvasZoomAnchor()))
  }, [canvasZoomAnchor, setCamera])
  const onZoomOut = useCallback(() => {
    setCamera((c) => zoomCameraBy(c, -1, canvasZoomAnchor()))
  }, [canvasZoomAnchor, setCamera])
  const onResetZoom = useCallback(() => {
    setCamera((c) => ({ ...c, zoom: 1 }))
  }, [setCamera])
  // Fit all widgets into view: zoom out (never in past 1:1) and center the
  // bounding box in the usable band between the title bar and the toolbar.
  //
  // This frames the *content*, which the camera's own window adaptation does
  // not: that keeps the proportion the user chose as the window changes size,
  // and has no idea where the widgets ended up. So Fit stays the way to say
  // "show me everything I have", and — like any other deliberate zoom — the
  // result it lands on becomes the new baseline the adaptation measures from.
  const onFitView = useCallback((): void => {
    const viewW = mainSize.w > 0 ? mainSize.w : window.innerWidth
    const viewH = mainSize.h > 0 ? mainSize.h : window.innerHeight
    // Maximized widgets already fill the viewport; framing them would feed
    // the camera-dependent geometry back into itself.
    const list = widgetsRef.current.filter((w) => !w.maximized)
    if (list.length === 0) return
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const w of list) {
      minX = Math.min(minX, w.x)
      minY = Math.min(minY, w.y)
      maxX = Math.max(maxX, w.x + w.w)
      maxY = Math.max(maxY, w.y + w.h)
    }
    setCamera(fitCameraToRect(viewW, viewH, TITLE_BAR_HEIGHT, TOOLBAR_RESERVE_PX, {
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY)
    }))
  }, [setCamera, mainSize.w, mainSize.h])
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

  // Geometry every widget had before the first arrange, so Free can put the
  // hand-dragged canvas back exactly as it was.
  const freeLayoutRef = useRef<Map<string, FreeLayoutEntry> | null>(null)
  const freeLayoutLoadedRef = useRef(false)
  if (!freeLayoutLoadedRef.current) {
    freeLayoutLoadedRef.current = true
    freeLayoutRef.current = readFreeLayout()
  }
  const arrangeInputRef = useRef({ widgets, camera, mainSize })
  arrangeInputRef.current = { widgets, camera, mainSize }

  useEffect(() => {
    const onArrange = (event: Event): void => {
      const mode = (event as CustomEvent<{ mode?: ArrangeMode }>).detail?.mode
      if (!mode) return
      const { widgets: current, camera: cam, mainSize: size } = arrangeInputRef.current

      if (mode === 'free') {
        const saved = freeLayoutRef.current
        freeLayoutRef.current = null
        writeFreeLayout(null)
        if (!saved) return
        const patches = current
          .filter((widget) => saved.has(widget.id))
          .map((widget) => ({ id: widget.id, change: { ...saved.get(widget.id)! } }))
        canvas.updateWidgets(patches, 'arrange')
        return
      }

      if (current.length === 0) return
      if (!freeLayoutRef.current) {
        freeLayoutRef.current = new Map(
          current.map((widget) => [
            widget.id,
            { x: widget.x, y: widget.y, w: widget.w, h: widget.h, maximized: widget.maximized }
          ])
        )
        writeFreeLayout(freeLayoutRef.current)
      }

      const zoom = cam.zoom || 1
      const viewW = size.w > 0 ? size.w : window.innerWidth
      const viewH = size.h > 0 ? size.h : window.innerHeight
      // The title bar floats over the canvas and the tool bar sits at the
      // bottom of it, so neither band is usable space for a tile.
      const usableH = Math.max(0, viewH - TITLE_BAR_HEIGHT - TOOLBAR_RESERVE_PX)
      const rects = arrangeWidgets(
        current,
        {
          x: -cam.x / zoom,
          y: titleBarWorldY(cam.y, zoom),
          w: viewW / zoom,
          h: usableH / zoom
        },
        mode
      )
      canvas.updateWidgets(
        rects.map(({ id, x, y, w, h }) => ({ id, change: { x, y, w, h, maximized: false } })),
        'arrange'
      )
    }
    window.addEventListener('orcspace:canvas-arrange', onArrange)
    return () => window.removeEventListener('orcspace:canvas-arrange', onArrange)
  }, [canvas.updateWidgets])

  useEffect(() => {
    const onNotice = (event: Event): void => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message
      if (message) setCanvasNotice(message)
    }
    window.addEventListener('orcspace:canvas-notice', onNotice)
    return () => window.removeEventListener('orcspace:canvas-notice', onNotice)
  }, [])

  const placeWidget = useCallback(
    (kind: WidgetKind, point: Point, requestedId?: string, title?: string, media?: { imagePath?: string; imageName?: string }): string | null => {
      const defaults = WIDGET_DEFAULTS[kind]
      const w = defaults.w
      const h = defaults.h
      const id = requestedId || `${kind}-${Date.now()}-${++localCounter}`


      if (requestedId && widgetsRef.current.some((widget) => widget.id === requestedId)) return requestedId
      if (!canvas.addWidget(clampToVisibleWorld(point, w, h), id, title, kind, media)) {
        setCanvasNotice('Canvas is full — close a widget before adding another.')
        return null
      }
      return id
  },
    [canvas.addWidget, clampToVisibleWorld]
  )

  const insertingImageRef = useRef(false)
  const insertImageFromClipboard = useCallback(async (): Promise<void> => {
    if (insertingImageRef.current) return
    insertingImageRef.current = true
    try {
      const saved = await window.api.media.saveClipboard()
      if (!saved) {
        setCanvasNotice('No image found in the clipboard.')
        return
      }
      const defaults = WIDGET_DEFAULTS.image
      const cx = mainSize.w > 0 ? mainSize.w / 2 : window.innerWidth / 2
      const cy = mainSize.h > 0 ? mainSize.h / 2 : window.innerHeight / 2
      const center = toWorld(cx, cy)
      const id = placeWidget(
        'image',
        { x: center.x - defaults.w / 2, y: center.y - defaults.h / 2 },
        undefined,
        saved.name,
        { imagePath: saved.path, imageName: saved.name }
      )
      if (id) setCanvasNotice(`Image added: ${saved.name}`)
    } catch (err) {
      setCanvasNotice(`Could not add image: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      insertingImageRef.current = false
    }
  }, [mainSize.h, mainSize.w, placeWidget, setCanvasNotice, toWorld])

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

  // Popups from Canvas browsers open a new canvas widget. Code browsers own
  // their popups and navigate their existing webview instead.
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
    return window.api.browser.onOpenTab(({ url, sourceWebContentsId }) => {
      if (isCodeBrowserGuest(sourceWebContentsId)) return
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

  const [snapGuides, setSnapGuides] = useState<{ x?: number; y?: number } | null>(null)

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
          canvas.suppressWidget(id, true)
          try { header.setPointerCapture(e.pointerId) } catch {}
        }
        const zoom = cameraRef.current.zoom || 1
        const snapThreshold = 8 / zoom

        const rawX = origX + (ev.clientX - startX) / startZoom
        const rawY = Math.max(
          origY + (ev.clientY - startY) / startZoom,
          titleBarWorldY(cameraRef.current.y, zoom)
        )

        let snappedX = rawX
        let snappedY = rawY
        let guideX: number | undefined
        let guideY: number | undefined

        if (!ev.altKey) {
          const others = widgetsRef.current.filter((w) => w.id !== id && !w.maximized)
          const myW = widget.w
          const myH = widget.h
          const myCenterX = rawX + myW / 2
          const myCenterY = rawY + myH / 2

          let bestDistX = snapThreshold
          let bestDistY = snapThreshold

          for (const other of others) {
            const otherRight = other.x + other.w
            const otherBottom = other.y + other.h
            const otherCenterX = other.x + other.w / 2
            const otherCenterY = other.y + other.h / 2

            // X alignments
            const dLeft = Math.abs(rawX - other.x)
            if (dLeft < bestDistX) {
              bestDistX = dLeft
              snappedX = other.x
              guideX = other.x
            }
            const dRight = Math.abs(rawX + myW - otherRight)
            if (dRight < bestDistX) {
              bestDistX = dRight
              snappedX = otherRight - myW
              guideX = otherRight
            }
            const dFlushRight = Math.abs(rawX - otherRight)
            if (dFlushRight < bestDistX) {
              bestDistX = dFlushRight
              snappedX = otherRight
              guideX = otherRight
            }
            const dFlushLeft = Math.abs(rawX + myW - other.x)
            if (dFlushLeft < bestDistX) {
              bestDistX = dFlushLeft
              snappedX = other.x - myW
              guideX = other.x
            }
            const dCenterX = Math.abs(myCenterX - otherCenterX)
            if (dCenterX < bestDistX) {
              bestDistX = dCenterX
              snappedX = otherCenterX - myW / 2
              guideX = otherCenterX
            }

            // Y alignments
            const dTop = Math.abs(rawY - other.y)
            if (dTop < bestDistY) {
              bestDistY = dTop
              snappedY = other.y
              guideY = other.y
            }
            const dBottom = Math.abs(rawY + myH - otherBottom)
            if (dBottom < bestDistY) {
              bestDistY = dBottom
              snappedY = otherBottom - myH
              guideY = otherBottom
            }
            const dFlushBottom = Math.abs(rawY - otherBottom)
            if (dFlushBottom < bestDistY) {
              bestDistY = dFlushBottom
              snappedY = otherBottom
              guideY = otherBottom
            }
            const dFlushTop = Math.abs(rawY + myH - other.y)
            if (dFlushTop < bestDistY) {
              bestDistY = dFlushTop
              snappedY = other.y - myH
              guideY = other.y
            }
            const dCenterY = Math.abs(myCenterY - otherCenterY)
            if (dCenterY < bestDistY) {
              bestDistY = dCenterY
              snappedY = otherCenterY - myH / 2
              guideY = otherCenterY
            }
          }

          // Also snap to center / origin (0, 0)
          if (Math.abs(rawX) < bestDistX) {
            snappedX = 0
            guideX = 0
          }
          if (Math.abs(rawY) < bestDistY) {
            snappedY = 0
            guideY = 0
          }
        }

        latestX = snappedX
        latestY = Math.max(snappedY, titleBarWorldY(cameraRef.current.y, zoom))
        setSnapGuides(guideX !== undefined || guideY !== undefined ? { x: guideX, y: guideY } : null)

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
        setSnapGuides(null)
        if (!dragging) return
        canvas.suppressWidget(id, false)
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
    [canvas.bringToFront, canvas.updateWidget, canvas.suppressWidget]
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
      // Resize commits every mousemove via updateWidget: suppress remote
      // upserts for its duration, same as header drag, or a remote move
      // lands mid-gesture and the release commit jumps.
      canvas.suppressWidget(id, true)

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
      const onResizeEnd = (): void => {
        canvas.suppressWidget(id, false)
      }
      // Same guard as the header drag above: a synthetic pointer event has
      // pointerId 0, and filtering moves against it drops every packet, so a
      // resize driven by automation never moves at all.
      trackDrag(onMove, onResizeEnd, e.pointerId > 0 ? e.pointerId : undefined)
    },
    [canvas.bringToFront, canvas.updateWidget, canvas.suppressWidget]
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
      canvas.toggleMaximize(id)
    },
    [canvas.toggleMaximize]
  )



  useEffect(() => {
    for (const w of widgets) {
      if (NON_MAXIMIZABLE.has((w.kind ?? 'terminal') as WidgetKind) && w.maximized) {
        canvas.updateWidget(w.id, { maximized: false })
      }
      // Repair a persisted size that is outside the kind's limits — saved
      // before the limit existed, or arrived from another client. This was
      // written as a hardcoded `timer > 360x320` check, which both duplicated
      // one row of WIDGET_MAX_SIZE in a second module and left every other
      // capped kind (links, files, music-player, orchestration) unrepairable.
      // clampWidgetSize is the one place those limits live.
      const size = clampWidgetSize(w.kind, w.w, w.h)
      if (size.w !== w.w || size.h !== w.h) canvas.updateWidget(w.id, size)
    }

    // Runs on every widgets change (not just length) so a kind change to a
    // non-maximizable kind restores it immediately. Converges: the second run
    // finds nothing to fix and issues no update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets])

  useEffect(() => {
    const maximizedWidget = widgets.find((w) => w.maximized)
    if (!maximizedWidget) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable || target.closest('.xterm'))) {
          return
        }
        e.preventDefault()
        canvas.toggleMaximize(maximizedWidget.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [widgets, canvas.toggleMaximize])

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




  const handleCanvasShortcut = useCallback((e: KeyboardEvent | React.KeyboardEvent<HTMLElement>): void => {
    const isGlobalZoom = (e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0')
    const target = e.target as HTMLElement | null
    const imageHotkey = matchesShortcut(e, settings.imageInsertShortcut || DEFAULT_IMAGE_INSERT_SHORTCUT)
    const imageHotkeyBlocked = Boolean(target?.closest(
      '[role="dialog"],input:not(.xterm-helper-textarea),textarea:not(.xterm-helper-textarea),select,[contenteditable="true"]'
    ))
    if (imageHotkey && !imageHotkeyBlocked) {
      e.preventDefault()
      void insertImageFromClipboard()
      return
    }
    if (
      !isGlobalZoom &&
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

      // The empty-canvas hint advertises T and N alongside +/-/0/F/Home. The
      // listener for `orcspace:new-terminal` already existed; nothing ever
      // dispatched it, so both keys were dead and the hint was a lie.
      if ((e.key === 't' || e.key === 'T' || e.key === 'n' || e.key === 'N') &&
        !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        window.dispatchEvent(new Event('orcspace:new-terminal'))
        return
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        onZoomIn()
        return
      }
      if (e.key === '-') {
        e.preventDefault()
        onZoomOut()
        return
      }
      if (e.key === '0') {
        e.preventDefault()
        // 0 resets only zoom and deliberately preserves the current pan.
        onResetZoom()
        return
      }
      if ((e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') &&
        !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Fit all widgets into view (also on the toolbar). Russian layout
        // included: the key sits where F is, mirroring the paste-shortcut
        // handling elsewhere in the app.
        e.preventDefault()
        onFitView()
        return
      }

      if (e.key === 'Home') {
        e.preventDefault()
        // Home resets the complete camera, including the pan position.
        setCamera({ x: 0, y: 0, zoom: 1 })
        return
      }
      return
    }
    e.preventDefault()
    const step = e.shiftKey ? 10 : 50
    setCamera((c) => ({ ...c, x: c.x - dir[0] * step, y: c.y - dir[1] * step }))
  }, [insertImageFromClipboard, onFitView, onResetZoom, onZoomIn, onZoomOut, setCamera, settings.imageInsertShortcut])

  useEffect(() => {
    if (!active) return
    const onWindowKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      handleCanvasShortcut(event)
    }
    window.addEventListener('keydown', onWindowKey)
    return () => window.removeEventListener('keydown', onWindowKey)
  }, [active, handleCanvasShortcut])

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

    if (tool === 'select' && e.button === 0) {
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      trackDrag(
        (ev) => {
          if (!moved) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
            moved = true
          }
          const left = Math.min(startX, ev.clientX)
          const top = Math.min(startY, ev.clientY)
          const width = Math.abs(ev.clientX - startX)
          const height = Math.abs(ev.clientY - startY)
          setSelectionBox({ x: left, y: top, w: width, h: height })
        },
        () => {
          setSelectionBox((currentBox) => {
            if (currentBox && moved) {
              const p1 = toWorld(currentBox.x, currentBox.y)
              const p2 = toWorld(currentBox.x + currentBox.w, currentBox.y + currentBox.h)
              const minX = Math.min(p1.x, p2.x)
              const maxX = Math.max(p1.x, p2.x)
              const minY = Math.min(p1.y, p2.y)
              const maxY = Math.max(p1.y, p2.y)
              const intersecting = widgetsRef.current.filter(
                (w) => !(w.x + w.w < minX || w.x > maxX || w.y + w.h < minY || w.y > maxY)
              )
              if (intersecting.length > 0) {
                const topOne = intersecting.reduce((best, cur) => (cur.z > best.z ? cur : best), intersecting[0])
                canvas.bringToFront(topOne.id)
              }
            }
            return null
          })
        }
      )
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
          next = zoomCameraAt(next, next.zoom * factor, { x: s.sx, y: s.sy })
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

  // Polls that outlive the canvas keep firing `deliver`/`onFailed` against a
  // torn-down tree, so every pending one is cancelled on unmount.
  const pendingDeliveriesRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    const pending = pendingDeliveriesRef.current
    return () => {
      for (const timer of pending) window.clearInterval(timer)
      pending.clear()
    }
  }, [])

  const deliverWhenMounted = useCallback(
    (
      widgetId: string,
      deliver: () => void,
      onDelivered: () => void,
      onFailed: () => void,
      isMounted: (id: string) => boolean = (id) => widgetsRef.current.some((w) => w.id === id),
      maxAttempts = 10
    ): void => {
      let attempts = 0
      const stop = (timer: number): void => {
        window.clearInterval(timer)
        pendingDeliveriesRef.current.delete(timer)
      }
      const timer = window.setInterval(() => {
        attempts += 1
        if (isMounted(widgetId)) {
          stop(timer)
          deliver()
          onDelivered()
        } else if (attempts >= maxAttempts) {
          stop(timer)
          onFailed()
        }
      }, 100)
      pendingDeliveriesRef.current.add(timer)
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

  useEffect(() => {
    return window.api.browser.onAgentAction(({ requestId, widgetId, action }) => {
      deliverWhenMounted(
        widgetId,
        () => window.dispatchEvent(new CustomEvent('orcspace:browser-agent-action', {
          detail: { requestId, widgetId, action }
        })),
        () => {},
        () => { void window.api.browser.respond(requestId, { ok: false, error: 'browser widget did not mount' }) },
        // Code browsers are not canvas widgets; ask the views themselves. A
        // browser just opened in Code needs a moment longer to mount.
        isBrowserMounted,
        30
      )
    })
  }, [deliverWhenMounted])

  const onCanvasDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    if (!e.dataTransfer || !e.dataTransfer.files.length) return

    const dropPoint = toWorld(e.clientX, e.clientY)
    const shortName = (name: string): string => (name.length > 80 ? `${name.slice(0, 77)}…` : name)
    const files = Array.from(e.dataTransfer.files)
    // Every file used to be placed at the identical drop point, so dropping a
    // folder's worth of images produced one visible widget with the rest
    // hidden exactly underneath it. Cascade them the way a file manager does.
    const CASCADE_PX = 28
    let placed = 0
    for (const file of files) {
      const filePoint = { x: dropPoint.x + placed * CASCADE_PX, y: dropPoint.y + placed * CASCADE_PX }
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
              const widgetId = placeWidget('music-player', filePoint)
              if (widgetId) {
                placed += 1
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
            const widgetId = placeWidget('browser', filePoint)
            if (widgetId) {
              placed += 1
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
        // mainSize is 0 on the very first paint (ResizeObserver hasn't fired
        // yet) — fall back to the window so a maximized widget restored from
        // storage doesn't flash at 0x0. Same fallback as clampToVisibleWorld.
        const viewW = mainSize.w > 0 ? mainSize.w : window.innerWidth
        const viewH = mainSize.h > 0 ? mainSize.h : window.innerHeight
        styles.set(widget.id, {
          left: -camera.x / zoom,
          top: (TITLE_BAR_HEIGHT - camera.y) / zoom,
          width: viewW / zoom,
          height: Math.max(0, viewH - TITLE_BAR_HEIGHT) / zoom,
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
        {strokes.length > 0 && <StrokesLayer strokes={strokes} camera={camera} width={mainSize.w} height={mainSize.h} />}
          {widgets.length === 0 && strokes.length === 0 && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
            aria-label="Empty canvas"
            role="status"
          >
            <div className="rounded-panel border border-line-soft bg-bg-panel/80 px-6 py-5 text-center shadow-xl backdrop-blur-md">
              <div className="mb-1 text-sm font-medium text-text">Your canvas is clear</div>
              <div className="mb-3 text-[11px] text-text-faint">Use the command bar below: /terminal, /chat, .files, @planner, or plain terminal</div>
              <button
                type="button"
                className="pointer-events-auto rounded-panel bg-accent px-3 py-1.5 text-[11px] font-medium text-bg hover:opacity-90"
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
              <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-text-faint">
                <kbd className="rounded-panel border border-line px-1 py-0.5 text-[9px] text-text-dim">T</kbd>{' '}
                <kbd className="rounded-panel border border-line px-1 py-0.5 text-[9px] text-text-dim">N</kbd>{' '}
                <kbd className="rounded-panel border border-line px-1 py-0.5 text-[9px] text-text-dim">+</kbd>{' '}
                <kbd className="rounded-panel border border-line px-1 py-0.5 text-[9px] text-text-dim">-</kbd>{' '}
                <span title="0 resets zoom only"><kbd className="rounded-panel border border-line px-1 py-0.5 text-[9px] text-text-dim">0</kbd> zoom</span>
                <span title="F fits all widgets into view"><kbd className="rounded-panel border border-line px-1 py-0.5 text-[9px] text-text-dim">F</kbd> fit</span>
                <span title="Home resets pan and zoom"><kbd className="rounded-panel border border-line px-1 py-0.5 text-[9px] text-text-dim">Home</kbd> view</span>
              </div>
            </div>
          </div>
        )}
        {
}
        <div className="absolute inset-0 h-px w-px origin-top-left" style={worldTransform}>
          {snapGuides?.x !== undefined && (
            <div
              data-testid="snap-guide-x"
              className="pointer-events-none absolute z-[220] w-px -translate-x-1/2 bg-accent/70 shadow-[0_0_6px_rgba(255,255,255,0.35)]"
              style={{
                left: snapGuides.x,
                top: -100000,
                height: 200000
              }}
            />
          )}
          {snapGuides?.y !== undefined && (
            <div
              data-testid="snap-guide-y"
              className="pointer-events-none absolute z-[220] h-px -translate-y-1/2 bg-accent/70 shadow-[0_0_6px_rgba(255,255,255,0.35)]"
              style={{
                top: snapGuides.y,
                left: -100000,
                width: 200000
              }}
            />
          )}
          {renderableWidgets.map((w) => (
            <WidgetFrame
              key={w.id}
              widget={w}
              active={w.z === topZ.current}
              editing={editingId === w.id}
              style={widgetStyles.get(w.id)!}
              {...widgetHandlers(w.id)}
              workspaceDir={workspaceDir}
              terminalsFlipped={terminalsFlipped}
            />
          ))}
        </div>
        {selectionBox && (
          <div
            className="pointer-events-none fixed z-[250] rounded border border-accent/70 bg-accent/10 backdrop-blur-[1px]"
            style={{
              left: selectionBox.x,
              top: selectionBox.y,
              width: selectionBox.w,
              height: selectionBox.h
            }}
          />
        )}
        {canvasNotice && (
          <div role="status" className="pointer-events-none absolute bottom-20 left-1/2 z-[300] -translate-x-1/2 rounded-panel border border-line bg-bg-panel/95 px-3 py-1.5 text-[11px] text-text shadow-lg">
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
            onPickImage={() => { placeWidget('image', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickLinks={() => { placeWidget('links', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickMusicPlayer={() => { placeWidget('music-player', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickChat={() => { placeWidget('chat', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickNotes={() => { placeWidget('notes', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickCalendar={() => { placeWidget('calendar', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickKanban={() => { placeWidget('kanban', toWorld(menu.x, menu.y)); setMenu(null) }}
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
        zoom={camera.zoom}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onResetZoom={onResetZoom}
        onFitView={onFitView}
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
