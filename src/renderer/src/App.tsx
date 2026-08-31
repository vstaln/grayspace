import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import WidgetFrame from './components/WidgetFrame'
import ContextMenu from './components/ContextMenu'
import TitleBar from './components/TitleBar'
import type { WorkView } from './components/TitleBar'
import { useCanvas, MAX_WIDGETS } from './hooks/useCanvas'
import { useCoordination } from './hooks/useCoordination'
import { Camera, MIN_H, MIN_W, Point, ResizeDir, Stroke, Widget, WidgetKind } from './types'
import Toolbar from './components/Toolbar'
import ErrorBoundary from './components/ErrorBoundary'
import StrokesLayer from './components/StrokesLayer'
import ConnectionsLayer from './components/ConnectionsLayer'
import { ThemeProvider, useTheme } from './theme'
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog'
import { useSettings } from './hooks/useSettings'
import { DRAW_CLICK_THRESHOLD_PX } from './lib/canvasMetrics'

// Heavy surfaces behind a first-use gate are also code-split: their modules
// (board UI and the browser pane) no
// longer parse and compile at startup — only when the user first opens them
// (PERF-lazy-surfaces). TerminalWidget stays eager on purpose: the canvas is
// the app's primary surface and terminals are its core widget.
const KanbanBoard = lazy(() => import('./components/KanbanBoard'))
const BrowserPane = lazy(() => import('./components/BrowserPane'))
const CodeView = lazy(() => import('./components/CodeView'))

/** Per-session counter so local widget ids never collide (CANV-12). */
let localCounter = 0

export default function App(): React.JSX.Element {
  // Which surface the title bar's switcher is showing. All three stay
  // mounted once started: the canvas owns live terminals, the browser owns
  // loaded pages, and Code owns its own terminal sessions — none of them
  // should be torn down just because another is on screen.
  const [activeView, setActiveView] = useState<WorkView>('canvas')
  // The browser view is built on first use, so a session that never opens
  // it pays nothing for the guest process. Same for the Code view.
  const [browserStarted, setBrowserStarted] = useState(false)
  const [codeStarted, setCodeStarted] = useState(false)
  const workspaceDirForUiRef = useRef<string | null>(null)

  // Restore Code sessions + last active view per workspace — so closing the
  // app with Code terminals running brings them back instead of starting empty
  // (user request: "сохранение на вкладку code после закрытия приложения").
  useEffect(() => {
    void window.api.workspace.getDir().then((dir) => {
      workspaceDirForUiRef.current = dir
    }).catch(() => {})
    const offDir = window.api.workspace.onDirChange((dir) => {
      workspaceDirForUiRef.current = dir
    })
    void window.api.code
      .load()
      .then((snap) => {
        if (snap.sessions && snap.sessions.length > 0) setCodeStarted(true)
        const av = (snap as unknown as { activeView?: WorkView }).activeView
        if (av === 'code' && snap.sessions.length > 0) {
          setCodeStarted(true)
          setActiveView('code')
        } else if (av === 'browser') {
          setBrowserStarted(true)
          setActiveView('browser')
        } else if (av === 'canvas') {
          setActiveView('canvas')
        }
      })
      .catch(() => {})
    const offCode = window.api.code.onChange((snap) => {
      if (snap.sessions && snap.sessions.length > 0) setCodeStarted((prev) => prev || true)
    })
    return () => {
      offDir()
      offCode()
    }
  }, [])

  const showView = useCallback((view: WorkView): void => {
    if (view === 'browser') setBrowserStarted(true)
    if (view === 'code') setCodeStarted(true)
    setActiveView(view)
    void window.api.code.save({ activeView: view, workspaceDir: workspaceDirForUiRef.current }).catch(() => {})
  }, [])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ConfirmProvider>
          <div className="relative flex h-full flex-col">
            <Wallpaper />
            <TitleBar activeView={activeView} onViewChange={showView} />
            <div className="flex flex-1 flex-col">
              <ErrorBoundary>
                <OrcSpaceCanvas active={activeView === 'canvas'} />
              </ErrorBoundary>
            </div>
            {browserStarted && (
              <ErrorBoundary>
                <Suspense fallback={null}>
                  <BrowserPane active={activeView === 'browser'} />
                </Suspense>
              </ErrorBoundary>
            )}
            {codeStarted && (
              <ErrorBoundary>
                <Suspense fallback={null}>
                  <CodeView active={activeView === 'code'} />
                </Suspense>
              </ErrorBoundary>
            )}
          </div>
        </ConfirmProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

/**
 * Only safe image data-URLs from main's media picker. Reject anything else so a
 * poisoned settings value cannot inject CSS via `url("...")` (quotes, `)`, etc.).
 */
function wallpaperBackgroundImage(background: string | null): string | undefined {
  if (!background) return undefined
  if (!/^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]+$/i.test(background)) {
    return undefined
  }
  return `url("${background}")`
}

/** The user's photo, shown behind the whole window in the `photo` theme. */
function Wallpaper(): React.JSX.Element | null {
  const { theme, background, dim, blur, pickBackground } = useTheme()
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
            style={{ backgroundColor: `rgba(0, 0, 0, ${dimRatio})` }}
          />
        )}
      </div>
      {!background && (
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

function OrcSpaceCanvas({ active }: { active: boolean }): React.JSX.Element {
  const { settings } = useSettings()
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
  const coordination = useCoordination()
  const confirm = useConfirm()
  const mainRef = useRef<HTMLElement>(null)
  // Track the canvas size so the minimap can draw the viewport rect and the
  // HUD can center zoom/fit on real dimensions (CANV-16).
  const [mainSize, setMainSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setMainSize({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Stable refs so the drag/wheel handlers and the memoized widget layer can
  // keep stable identities (and thus skip re-renders) while still reading the
  // latest camera/widget state.
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const widgetsRef = useRef(widgets)
  widgetsRef.current = widgets

  // `screenToWorld` treats (0,0) as the canvas's own top-left, but `clientX/Y`
  // are relative to the whole window — and `<main>` sits offset from that by
  // the sidebar's width and the title bar's height. Skipping this subtraction
  // is invisible for drag deltas (only the difference between two readings
  // matters there) but puts every absolute placement — a drawn stroke most
  // visibly — off by that offset from the actual cursor.
  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = mainRef.current?.getBoundingClientRect()
      return screenToWorld(clientX - (rect?.left ?? 0), clientY - (rect?.top ?? 0))
    },
    [screenToWorld]
  )

  const [menu, setMenu] = useState<Point | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  editingRef.current = editingId
  const [boardOpen, setBoardOpen] = useState(false)
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

  // P2-205: one Escape closes the frontmost transient layer — a widget-title
  // edit first, then the context menu, board, brain, chat. Text fields keep
  // the key to themselves so the chat input or note editor isn't yanked away.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (editingRef.current) return setEditingId(null)
      const target = e.target as HTMLElement | null
      // Text fields keep the key to themselves first: an Escape meant to cancel
      // an autocomplete or clear an input must not also dismiss the panel. This
      // must run before the board branch or the picker's search box would be
      // yanked out from under the user.
      if (target?.closest?.('input,textarea,select')) return
      if (menu) return setMenu(null)
      if (boardOpen) return setBoardOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu, boardOpen])

  useEffect(() => {
    const onOpenBoard = (): void => setBoardOpen(true)
    window.addEventListener('orcspace:open-board', onOpenBoard)
    return () => window.removeEventListener('orcspace:open-board', onOpenBoard)
  }, [])

  const closeWidget = useCallback(
    (id: string): void => {
      // removeWidget disposes terminal shells when the kind is terminal.
      canvas.removeWidget(id)
      setEditingId((cur) => (cur === id ? null : cur))
      // Drop the cached bound handlers: a session that opens and closes many
      // widgets must not accumulate one stale entry per id ever created.
      handlerCacheRef.current.delete(id)
    },
    [canvas.removeWidget]
  )

  const spawnTerminalAtCenter = useCallback((): void => {
    if (!canvas.addWidget(toWorld(window.innerWidth / 2 - 260, window.innerHeight / 2 - 180))) {
      setCanvasNotice('Canvas is full — close a widget before adding another.')
    }
  }, [canvas.addWidget, toWorld])

  useEffect(() => {
    const onNewTerminal = (): void => spawnTerminalAtCenter()
    window.addEventListener('orcspace:new-terminal', onNewTerminal)
    return () => window.removeEventListener('orcspace:new-terminal', onNewTerminal)
  }, [spawnTerminalAtCenter])

  const placeWidget = useCallback(
    (kind: WidgetKind, point: Point): void => {
      if (!canvas.addWidget(point, `${kind}-${Date.now()}-${++localCounter}`, undefined, kind)) {
        setCanvasNotice('Canvas is full — close a widget before adding another.')
      }
    },
    [canvas.addWidget]
  )

  /* Notes/Second Brain were removed; canvas widgets are self-contained. */
  /* const spawnNoteAt = useCallback(
    (point: Point): void => {
      // Check before creating, not after: a full canvas would otherwise leave
      // an orphan "New Note" in the brain with no widget ever showing it.
      if (widgetsRef.current.length >= MAX_WIDGETS) {
        setCanvasNotice('Canvas is full — close a widget before adding another.')
        return
      }
      void window.api.brain
        .create({ title: 'New Note', content: '', tags: [], projectDir: workspaceDir || undefined })
        .then((note) => {
          if (!note || 'error' in note) return
          if (!canvas.addNoteWidget(point, note.id, note.title)) {
            setCanvasNotice('Canvas is full — close a widget before adding another.')
          }
        })
        .catch(() => {
          // removed note handler
        })
    },
    [canvas.addNoteWidget, workspaceDir]
  ) */

  // Stable rail callbacks — see the note above the drag handlers (PERF-rail-memo).
  const onToggleBoard = useCallback((): void => setBoardOpen((v) => !v), [])
  const onPickDir = useCallback((): void => {
    // The result arrives via workspace:onDirChange; a rejected dialog is not
    // actionable here, but it must not surface as an unhandled rejection.
    void window.api.workspace.pickDir().catch((err) => console.warn('workspace:pickDir failed', err))
  }, [])

  // ---- dragging & resizing (screen deltas are divided by zoom) ------------
  // Handlers take the widget id as an argument instead of closing over it, so
  // they keep a stable identity across renders and React.memo on the widget
  // layer can actually skip re-renders while another widget drags.
  //
  // The rail's callbacks below follow the same rule: the canvas re-renders on
  // every camera frame, and fresh arrow-function props would drag the memoized
  // Sidebar along with every one of those frames (PERF-rail-memo).
  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent, id: string): void => {
      if (editingRef.current === id || (e.target as HTMLElement).closest('button,input')) return
      e.preventDefault()
      canvas.bringToFront(id)
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget || widget.maximized) return

      const startX = e.clientX
      const startY = e.clientY
      const { x: origX, y: origY } = widget
      const startZoom = cameraRef.current.zoom
      const onMove = (ev: MouseEvent): void => {
        canvas.updateWidget(id, {
          x: origX + (ev.clientX - startX) / startZoom,
          y: origY + (ev.clientY - startY) / startZoom
        })
      }
      trackDrag(onMove)
    },
    [canvas]
  )

  const onResizeStart = useCallback(
    (e: React.PointerEvent, id: string, dir: ResizeDir): void => {
      e.preventDefault()
      e.stopPropagation()
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
        let [x, y, w, h] = [ox, oy, ow, oh]
        if (dir.includes('e')) w = Math.max(MIN_W, ow + dx)
        if (dir.includes('s')) h = Math.max(MIN_H, oh + dy)
        if (dir.includes('w')) {
          w = Math.max(MIN_W, ow - dx)
          x = ox + ow - w
        }
        if (dir.includes('n')) {
          h = Math.max(MIN_H, oh - dy)
          y = oy + oh - h
        }
        canvas.updateWidget(id, { x, y, w, h })
      }
      trackDrag(onMove)
    },
    [canvas]
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
      // Note titles/content are persisted by NoteWidget's own debounced save
      // (DI-003). Writing here too would race that save on every keystroke —
      // two async writers hitting the same note → duplicate writes, lost
      // keystrokes, and baseVersion conflicts when main rejects stale writes.
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
      const next = !widget.maximized
      // One maximized frame at a time — stacked 9000 z-indexes had no switcher.
      for (const other of widgetsRef.current) {
        if (other.id !== id && other.maximized) canvas.updateWidget(other.id, { maximized: false })
      }
      canvas.updateWidget(id, { maximized: next })
      canvas.bringToFront(id)
    },
    [canvas.updateWidget, canvas.bringToFront]
  )
  const onWidgetClose = useCallback(
    (id: string): void => {
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (widget && (widget.kind ?? 'terminal') === 'terminal') {
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

  // P3-219: keyboard alternative for widget move/resize/remove. Fires only when
  // the widget frame itself has focus (not an inner input), reads the latest
  // position through widgetsRef so the bound handler can stay cached/stable.
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
        // Escape is the one key the frame claims for navigation: it hands focus
        // back to the canvas so the arrow keys return to panning instead of
        // still moving a widget the user thought they had left (CANV-14).
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          mainRef.current?.focus()
          return
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          onWidgetClose(id)
        }
        return
      }
      const step = e.shiftKey ? 16 : 1
      e.preventDefault()
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget || widget.maximized) return
      const [dx, dy] = dir
      if (e.altKey) {
        // Alt+arrow resizes toward the pressed edge, keeping the opposite one
        // pinned (mirrors the mouse resize handles, clamped to MIN_W/MIN_H).
        let { x, y, w: width, h: height } = widget
        if (dx > 0) width = Math.max(MIN_W, width + dx * step)
        else if (dx < 0) {
          const shrunk = Math.max(MIN_W, width + dx * step)
          x += width - shrunk
          width = shrunk
        }
        if (dy > 0) height = Math.max(MIN_H, height + dy * step)
        else if (dy < 0) {
          const shrunk = Math.max(MIN_H, height + dy * step)
          y += height - shrunk
          height = shrunk
        }
        canvas.updateWidget(id, { x, y, w: width, h: height })
      } else {
        canvas.updateWidget(id, { x: widget.x + dx * step, y: widget.y + dy * step })
      }
    },
    [canvas]
  )

  // P3-219: keyboard pan — arrows move the view while the canvas itself has
  // focus; Shift+arrows make fine 10px steps.
  const onCanvasKey = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget) return
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    }
    const dir = dirs[e.key]
    if (!dir) return
    e.preventDefault()
    const step = e.shiftKey ? 10 : 50
    setCamera((c) => ({ ...c, x: c.x - dir[0] * step, y: c.y - dir[1] * step }))
  }

  const onCanvasPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.widget, .board, .board-shell, .rail, [data-canvas-scroll-lock]')) return

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
          // A plain click never moved past the threshold — drop the stroke so
          // it doesn't leave a stray dot on the canvas (CANV-dot).
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

    // The hand tool pans on a plain drag; otherwise panning stays a deliberate
    // gesture (middle-click, or shift so a plain drag can still select/draw).
    const wantsPan = tool === 'pan' ? e.button === 0 : e.button === 1 || (e.button === 0 && e.shiftKey)
    if (!wantsPan) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const origin = camera
    setIsPanning(true)
    // Pointer moves arrive far faster than frames (a fast mouse or trackpad
    // easily exceeds 60/s); committing a fresh camera to React state on every
    // one of them re-renders the whole canvas more often than the screen can
    // show. Batch into one commit per animation frame instead — mirrors the
    // wheel-pan/zoom path below (PERF-002) — and flush whatever is pending on
    // pointerup so the final position is never dropped.
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

  // Wheel events arrive faster than frames; the steps are accumulated and the
  // camera state is flushed once per animation frame instead of re-rendering
  // the whole canvas on every wheel tick (PERF-002). Zoom keeps the world point
  // under the cursor pinned — the anchor must be measured relative to the
  // canvas itself, not the window, or every step drifts by the canvas offset
  // (P2-203).
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

  // A native listener, not a React onWheel prop: React delegates wheel as a
  // PASSIVE root listener, so preventDefault() inside the prop is a no-op and
  // Ctrl+wheel / trackpad pinch would page-zoom the whole Electron window on
  // top of the camera zoom while spamming console warnings every tick.
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent): void => {
      // Scroll events bubble from widgets and inner panels. Don't touch the
      // camera when the user was scrolling inside any widget, panel, or menu.
      if (
        (e.target as HTMLElement).closest(
          '.widget, .widget-shell, .widget-body, [data-canvas-scroll-lock], .board-shell, .rail, [role="dialog"], [role="alertdialog"], [role="menu"], input, textarea, select, .xterm, .term-shell, .term'
        )
      ) {
        return
      }
      e.preventDefault()

      const rect = mainRef.current?.getBoundingClientRect()
      const sx = e.clientX - (rect?.left ?? 0)
      const sy = e.clientY - (rect?.top ?? 0)

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
    return () => el.removeEventListener('wheel', handleWheel)
  }, [flushWheel])

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if ((e.target as HTMLElement).closest('.widget, .board, .board-shell, .rail, [data-canvas-scroll-lock]')) return
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const openTasks = coordination.snapshot.tasks.filter(
    (t) => t.state !== 'done' && t.state !== 'cancelled'
  ).length

  // Viewport culling (PERF-cull): far off-screen widgets don't get a
  // WidgetFrame at all — the DOM tree they'd otherwise cost is never built.
  // Padded by one extra viewport on each side so a normal pan/zoom gesture
  // doesn't mount/unmount a widget mid-drag.
  //
  // Restricted to terminal widgets only. Unmounting one is proven safe —
  // TerminalWidget's cleanup "parks" the pty instead of killing it, and a
  // remount reconnects and repaints the live scrollback (see
  // `terminal.detach`/`terminal.create` in TerminalWidget.tsx) — so this only
  // costs an IPC round-trip, not state. Every other kind is unmount-unsafe in
  // ways that are silent, not crashes: a `browser` widget's `<webview>` has no
  // such reconnect path and would come back at HOME_URL, losing wherever the
  // user had navigated to; a `note` widget could have a debounced save still
  // pending when it unmounts, dropping the last keystrokes. Culling those too
  // would trade a DOM-cost saving for state loss the user would only notice
  // later, far from the pan that caused it — not worth it for widget kinds
  // that are typically far fewer and lighter than terminals anyway.
  const renderableWidgets = useMemo(() => {
    if (!mainSize.w || !mainSize.h) return widgets
    const zoom = camera.zoom || 1
    const minX = (-mainSize.w - camera.x) / zoom
    const minY = (-mainSize.h - camera.y) / zoom
    const maxX = (2 * mainSize.w - camera.x) / zoom
    const maxY = (2 * mainSize.h - camera.y) / zoom
    return widgets.filter((w) => {
      if (w.maximized) return true
      if ((w.kind ?? 'terminal') !== 'terminal') return true
      return w.x + w.w >= minX && w.x <= maxX && w.y + w.h >= minY && w.y <= maxY
    })
  }, [widgets, camera.x, camera.y, camera.zoom, mainSize.w, mainSize.h])

  /** Camera as one transform for the whole world layer. Widgets position
   *  themselves at raw world coordinates inside it, so a pan/zoom writes a
   *  single style instead of fresh left/top/scale into every WidgetFrame —
   *  the frames' props stay identical and their React.memo skips the frame
   *  entirely (PERF-layer-transform). */
  const worldTransform = useMemo(
    () => ({
      transform: `translate3d(${camera.x}px, ${camera.y}px, 0px) scale(${camera.zoom})`,
      willChange: isPanning ? 'transform' : 'auto'
    }),
    [camera.x, camera.y, camera.zoom, isPanning]
  )

  /** In-canvas widgets sit in world coordinates inside the scaled layer; a
   *  maximized widget floats above everything and fills the canvas area.
   *  A fresh object per call is fine: WidgetFrame's memo comparator compares
   *  the style fields individually, so identity churn does not defeat it. */
  const widgetStyle = (w: Widget): React.CSSProperties => ({
    left: w.x,
    top: w.y,
    width: w.w,
    height: w.h,
    zIndex: w.z
  })

  // Maximized frames render outside the world layer (they must not inherit its
  // scale). One maximized widget at a time is an App invariant, but filtering
  // keeps this correct even if that ever changes.
  const maximizedWidgets = useMemo(() => widgets.filter((w) => w.maximized), [widgets])
  const inWorldWidgets = useMemo(() => renderableWidgets.filter((w) => !w.maximized), [renderableWidgets])

  /** WidgetFrame takes id-less callbacks; bind the widget id here so the
   *  handlers above keep stable identities for React.memo. The bound objects
   *  are cached per id — every backing callback below is itself stable, so
   *  re-instantiating this map on every frame would defeat the frame memo. */
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

  // Bound-handler cache GC. closeWidget() deletes its own entry, but widgets
  // removed by agents (control:remove-widget → canvas.onChange) bypass it —
  // without this sweep a long session that spawns and closes many agent
  // terminals accumulates one dead 11-closure bundle per id forever
  // (PERF-handler-gc).
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
      <Sidebar
        workspaceDir={workspaceDir}
        managerId={coordination.snapshot.managerId}
        boardOpen={boardOpen}
        taskCount={openTasks}
        onToggleBoard={onToggleBoard}
        onPickDir={onPickDir}
      />
      <div className={active ? 'contents' : 'contents invisible pointer-events-none'} aria-hidden={!active}>
      <main
        ref={mainRef}
        data-testid="canvas"
        className="canvas-area relative flex-1 overflow-hidden select-none outline-none focus:outline-none"
        tabIndex={0}
        onPointerDown={onCanvasPointerDown}
        onContextMenu={onContextMenu}
        onKeyDown={onCanvasKey}
        style={{
          // Without touch-action:none a touch drag on the canvas scrolls the
          // OS page instead of drawing/panning; the widget chrome below sets
          // its own touch-action so inner scrolling still works (CANV-15).
          touchAction: 'none',
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
          {/* Full `widgets`, not the culled/maximize-filtered list: an arc
              anchored to a maximized widget must still draw to its stored
              position instead of vanishing with its endpoint. */}
          <ConnectionsLayer connections={connections} widgets={widgets} />
        </div>
        <StrokesLayer strokes={strokes} camera={camera} width={mainSize.w} height={mainSize.h} />
        {/* World layer for widget frames — same transform as the connections
            layer above. Painting order stays connections → ink → widgets. */}
        <div className="absolute inset-0 h-px w-px origin-top-left" style={worldTransform}>
          {inWorldWidgets.map((w) => (
            <WidgetFrame
              key={w.id}
              widget={w}
              active={w.z === topZ.current}
              editing={editingId === w.id}
              style={widgetStyle(w)}
              {...widgetHandlers(w.id)}
              workspaceDir={workspaceDir}
            />
          ))}
        </div>
        {/* Maximized frames float above the world layer unscaled; the stable
            module-level style keeps their memo comparison trivially equal. */}
        {maximizedWidgets.map((w) => (
          <WidgetFrame
            key={w.id}
            widget={w}
            active={w.z === topZ.current}
            editing={editingId === w.id}
            style={MAXIMIZED_STYLE}
            {...widgetHandlers(w.id)}
            workspaceDir={workspaceDir}
          />
        ))}
        {canvasNotice && (
          <div role="status" className="pointer-events-none absolute bottom-14 left-1/2 z-[300] -translate-x-1/2 rounded-[10px] border border-line bg-bg-panel/95 px-3 py-1.5 text-[11px] text-text shadow-lg">
            {canvasNotice}
          </div>
        )}
        {menu && (
          <ContextMenu
            at={menu}
            onPickTerminal={() => {
              if (!canvas.addWidget(toWorld(menu.x, menu.y))) {
                setCanvasNotice('Canvas is full — close a widget before adding another.')
              }
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
            onPickIdGenerator={() => { placeWidget('id-generator', toWorld(menu.x, menu.y)); setMenu(null) }}
            favoriteWidgets={settings.favoriteWidgets ?? []}
            onClose={() => setMenu(null)}
          />
        )}
      </main>

      {boardOpen && (
        <Suspense fallback={null}>
          <KanbanBoard
            snapshot={coordination.snapshot}
            onCreate={(title, brief) => coordination.createTask(title, brief)}
            onMove={(id, state) => coordination.moveTask(id, state)}
            onDelete={(id) => coordination.deleteTask(id)}
            onResetManager={async () => {
              const ok = await confirm('Reset lead role? Any agent will be able to claim it again.')
              return ok ? coordination.resetManager() : { ok: true }
            }}
            onReleaseLocks={async () => {
              const ok = await confirm('Release all file locks?')
              return ok ? coordination.releaseLocks() : { ok: true }
            }}
            onClose={() => setBoardOpen(false)}
          />
        </Suspense>
      )}
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
      />
      </div>
    </div>
  )
}

/**
 * Runs `onMove` for the duration of a pointer drag, then cleans itself up.
 * Pointer events unify mouse, touch and pen into one code path (CANV-15); the
 * callbacks only read clientX/clientY, which PointerEvent inherits from
 * MouseEvent, so existing mouse-typed handlers keep working unchanged.
 */
function trackDrag(onMove: (e: PointerEvent) => void, onEnd?: () => void): void {
  const release = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', release)
    window.removeEventListener('blur', release)
    window.removeEventListener('pointercancel', release)
    onEnd?.()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', release)
  // The window can lose focus while the button is still down (alt-tab, click
  // on another window); without these the drag stays stuck until the next
  // click ever lands on the window (P2-208).
  window.addEventListener('blur', release)
  window.addEventListener('pointercancel', release)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** A maximized frame fills the canvas area below the title bar. Rendered
 *  outside the world layer, so no scale/transform applies; starts at top: 40
 *  to sit below the top title bar and keep its controls reachable. One stable
 *  identity for every maximized frame keeps the memo comparison all-equal. */
const MAXIMIZED_STYLE: React.CSSProperties = { left: 0, top: 40, right: 0, bottom: 0, zIndex: 200 }
