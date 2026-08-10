import React, { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import KanbanBoard from './components/KanbanBoard'
import WidgetFrame from './components/WidgetFrame'
import ContextMenu from './components/ContextMenu'
import TitleBar from './components/TitleBar'
import { useCanvas } from './hooks/useCanvas'
import { useCoordination } from './hooks/useCoordination'
import { HEADER_H, MIN_H, MIN_W, Point, ResizeDir, Stroke, Widget, WidgetKind } from './types'
import ChatPanel from './components/ChatPanel'
import SecondBrain from './components/SecondBrain'
import Toolbar from './components/Toolbar'
import ErrorBoundary from './components/ErrorBoundary'
import StrokesLayer from './components/StrokesLayer'
import ConnectionsLayer from './components/ConnectionsLayer'
import { ThemeProvider, useTheme } from './theme'
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog'

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ConfirmProvider>
          <div className="flex h-full flex-col">
            <Wallpaper />
            <TitleBar />
            <ErrorBoundary>
              <OrcSpaceCanvas />
            </ErrorBoundary>
          </div>
        </ConfirmProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

/** The user's photo, shown behind the whole window in the `photo` theme. */
function Wallpaper(): React.JSX.Element | null {
  const { theme, background, dim } = useTheme()
  if (theme !== 'photo') return null
  return (
    <div
      className="wallpaper-layer"
      style={
        {
          backgroundImage: background ? `url("${background}")` : undefined,
          '--wallpaper-dim': dim / 100
        } as React.CSSProperties
      }
    />
  )
}

function OrcSpaceCanvas(): React.JSX.Element {
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
  const [assistantRequest, setAssistantRequest] = useState(0)
  const [brainOpen, setBrainOpen] = useState(false)
  const [brainView, setBrainView] = useState<'list' | 'graph'>('list')
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  useEffect(() => {
    void window.api.workspace.getDir().then(setWorkspaceDir)
    return window.api.workspace.onDirChange(setWorkspaceDir)
  }, [])

  // P2-205: one Escape closes the frontmost transient layer — a widget-title
  // edit first, then the context menu, board, brain, chat. Text fields keep
  // the key to themselves so the chat input or note editor isn't yanked away.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (editingRef.current) return setEditingId(null)
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select')) return
      if (menu) return setMenu(null)
      if (boardOpen) return setBoardOpen(false)
      if (brainOpen) return setBrainOpen(false)
      setChatOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu, boardOpen, brainOpen, chatOpen])

  const closeWidget = useCallback(
    (id: string): void => {
      canvas.removeWidget(id)
      setEditingId((cur) => (cur === id ? null : cur))
    },
    [canvas.removeWidget]
  )

  const spawnTerminalAtCenter = useCallback(
    (): void => canvas.addWidget(toWorld(window.innerWidth / 2 - 260, window.innerHeight / 2 - 180)),
    [canvas.addWidget, toWorld]
  )

  /**
   * Drops a widget that needs no external resource at the point the context
   * menu was opened — git status, a timer, the schedule, the board. Terminals
   * and notes go through their own paths because each has to create something
   * first (a PTY, a note in the brain).
   */
  const placeWidget = useCallback(
    (kind: WidgetKind, point: Point): void => {
      canvas.addWidget(point, `${kind}-${Date.now()}`, undefined, kind)
    },
    [canvas.addWidget]
  )

  const spawnNoteAt = useCallback(
    (point: Point): void => {
      void window.api.brain
        .create({ title: 'Новая заметка', content: '', tags: [], projectDir: workspaceDir || undefined })
        .then((note) => canvas.addNoteWidget(point, note.id, note.title))
    },
    [canvas.addNoteWidget, workspaceDir]
  )

  // ---- dragging & resizing (screen deltas are divided by zoom) ------------
  // Handlers take the widget id as an argument instead of closing over it, so
  // they keep a stable identity across renders and React.memo on the widget
  // layer can actually skip re-renders while another widget drags.
  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent, id: string): void => {
      if (editingRef.current === id || (e.target as HTMLElement).closest('button,input')) return
      e.preventDefault()
      canvas.bringToFront(id)
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget || widget.maximized) return

      const startX = e.clientX
      const startY = e.clientY
      const { x: origX, y: origY } = widget
      const onMove = (ev: MouseEvent): void => {
        const zoom = cameraRef.current.zoom
        canvas.updateWidget(id, {
          x: origX + (ev.clientX - startX) / zoom,
          y: origY + (ev.clientY - startY) / zoom
        })
      }
      trackDrag(onMove)
    },
    [canvas]
  )

  const onResizeStart = useCallback(
    (e: React.MouseEvent, id: string, dir: ResizeDir): void => {
      e.preventDefault()
      e.stopPropagation()
      canvas.bringToFront(id)
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (!widget || widget.maximized) return

      const startX = e.clientX
      const startY = e.clientY
      const { x: ox, y: oy, w: ow, h: oh } = widget
      const onMove = (ev: MouseEvent): void => {
        const zoom = cameraRef.current.zoom
        const dx = (ev.clientX - startX) / zoom
        const dy = (ev.clientY - startY) / zoom
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
  const onStartEditing = useCallback((id: string): void => setEditingId(id), [])
  const onRename = useCallback(
    (id: string, title: string): void => {
      canvas.updateWidget(id, { title })
      setEditingId((cur) => (cur === id ? null : cur))
    },
    [canvas.updateWidget]
  )
  const onCancelEditing = useCallback((id: string): void => setEditingId((cur) => (cur === id ? null : cur)), [])
  const onToggleMinimize = useCallback(
    (id: string): void => {
      const widget = widgetsRef.current.find((w) => w.id === id)
      if (widget) canvas.updateWidget(id, { minimized: !widget.minimized })
    },
    [canvas.updateWidget]
  )
  const onWidgetClose = useCallback((id: string): void => closeWidget(id), [closeWidget])

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
    [canvas, onWidgetClose]
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

  const onCanvasMouseDown = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('.widget,.board,.rail')) return

    if (tool === 'draw' && e.button === 0) {
      e.preventDefault()
      const strokeId = canvas.beginStroke(toWorld(e.clientX, e.clientY))
      trackDrag((ev) => canvas.extendStroke(strokeId, toWorld(ev.clientX, ev.clientY)))
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
    trackDrag((ev) =>
      setCamera({ ...origin, x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY })
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
      for (const step of steps) {
        if (step.kind === 'pan') {
          next = { ...next, x: next.x + step.dx, y: next.y + step.dy }
        } else {
          // Keep the world point under (sx, sy) stationary: cam.x = sx - world.x*zoom.
          const zoom = clamp(next.zoom * (step.deltaY < 0 ? 1.1 : 0.9), 0.6, 2)
          next = {
            zoom,
            x: step.sx - ((step.sx - next.x) / next.zoom) * zoom,
            y: step.sy - ((step.sy - next.y) / next.zoom) * zoom
          }
        }
      }
      return next
    })
  }, [setCamera])

  useEffect(() => () => {
    if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current)
  }, [])

  const onWheel = (e: React.WheelEvent): void => {
    if ((e.target as HTMLElement).closest('.board,.term')) return
    if (e.ctrlKey) {
      const rect = mainRef.current?.getBoundingClientRect()
      wheelStepsRef.current.push({
        kind: 'zoom',
        sx: e.clientX - (rect?.left ?? 0),
        sy: e.clientY - (rect?.top ?? 0),
        deltaY: e.deltaY
      })
    } else {
      wheelStepsRef.current.push({ kind: 'pan', dx: -e.deltaX, dy: -e.deltaY })
    }
    if (wheelRafRef.current === null) wheelRafRef.current = requestAnimationFrame(flushWheel)
  }

  const openTasks = coordination.snapshot.tasks.filter(
    (t) => t.state !== 'done' && t.state !== 'cancelled'
  ).length

  const visibleWidgets = widgets.filter((w) => !w.maximized)
  const maximizedWidgets = widgets.filter((w) => w.maximized)

  /** In-canvas widgets sit in world coordinates inside the scaled layer; a
   *  maximized widget floats above everything and fills the canvas area. The
   *  result is cached per widget object, so moving one widget does not hand
   *  its untouched neighbours a fresh style identity every frame (PERF-001). */
  const styleCacheRef = useRef(new WeakMap<Widget, React.CSSProperties>())
  const widgetStyle = (w: Widget): React.CSSProperties => {
    const cached = styleCacheRef.current.get(w)
    if (cached) return cached
    const style = w.maximized
      ? { left: 0, top: HEADER_H, right: 0, bottom: 0 }
      : { left: w.x, top: w.y, width: w.w, height: w.minimized ? 34 : w.h }
    styleCacheRef.current.set(w, style)
    return style
  }

  /** WidgetFrame takes id-less callbacks; bind the widget id here so the
   *  handlers above keep stable identities for React.memo. The bound objects
   *  are cached per id — every backing callback below is itself stable, so
   *  the cache never goes stale and untouched widgets skip re-rendering
   *  entirely while another widget drags (PERF-001). */
  interface BoundWidgetHandlers {
    onFocus: () => void
    onHeaderMouseDown: (e: React.MouseEvent) => void
    onResizeStart: (e: React.MouseEvent, dir: ResizeDir) => void
    onStartEditing: () => void
    onRename: (title: string) => void
    onCancelEditing: () => void
    onToggleMinimize: () => void
    onClose: () => void
    onKeyDown: (e: React.KeyboardEvent) => void
  }
  const handlersRef = useRef<Map<string, BoundWidgetHandlers>>(new Map())
  const widgetHandlers = (id: string): BoundWidgetHandlers => {
    const cached = handlersRef.current.get(id)
    if (cached) return cached
    const bound: BoundWidgetHandlers = {
      onFocus: () => onWidgetFocus(id),
      onHeaderMouseDown: (e: React.MouseEvent) => onHeaderMouseDown(e, id),
      onResizeStart: (e: React.MouseEvent, dir: ResizeDir) => onResizeStart(e, id, dir),
      onStartEditing: () => onStartEditing(id),
      onRename: (title: string) => onRename(id, title),
      onCancelEditing: () => onCancelEditing(id),
      onToggleMinimize: () => onToggleMinimize(id),
      onClose: () => onWidgetClose(id),
      onKeyDown: (e: React.KeyboardEvent) => onFrameKey(e, id)
    }
    handlersRef.current.set(id, bound)
    return bound
  }

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar
        workspaceDir={workspaceDir}
        managerId={coordination.snapshot.managerId}
        boardOpen={boardOpen}
        brainOpen={brainOpen && brainView === 'list'}
        graphOpen={brainOpen && brainView === 'graph'}
        taskCount={openTasks}
        onNewTerminal={spawnTerminalAtCenter}
        onToggleBoard={() => setBoardOpen((v) => !v)}
        onToggleBrain={() => {
          // Re-clicking while the graph is up brings the notes back rather than closing.
          if (brainOpen && brainView === 'graph') return setBrainView('list')
          setBrainOpen((v) => !v)
          setBrainView('list')
        }}
        onToggleGraph={() => {
          if (brainOpen && brainView === 'graph') return setBrainOpen(false)
          setBrainOpen(true)
          setBrainView('graph')
        }}
        onPickDir={() => void window.api.workspace.pickDir().then(setWorkspaceDir)}
        onResetManager={() => void coordination.resetManager()}
      />

      <main
        ref={mainRef}
        tabIndex={0}
        aria-label="Холст"
        className="desktop-surface relative min-w-0 flex-1 overflow-hidden"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('.widget,.board')) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onMouseDown={onCanvasMouseDown}
        onWheel={onWheel}
        onKeyDown={onCanvasKey}
        style={{
          cursor: tool === 'pan' ? 'grab' : tool === 'draw' || tool === 'erase' ? 'crosshair' : 'default'
        }}
      >
        {maximizedWidgets.map((w) => (
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
        <div
          className="absolute inset-0 h-px w-px origin-top-left"
          style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
        >
          <ConnectionsLayer connections={connections} widgets={visibleWidgets} />
          <StrokesLayer strokes={strokes} />
          {visibleWidgets.map((w) => (
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

        {menu && (
          <ContextMenu
            at={menu}
            onPickTerminal={() => {
              canvas.addWidget(toWorld(menu.x, menu.y))
              setMenu(null)
            }}
            onPickNote={() => { spawnNoteAt(toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickGit={() => { placeWidget('git-status', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickTimer={() => { placeWidget('timer', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickSchedule={() => { placeWidget('schedule', toWorld(menu.x, menu.y)); setMenu(null) }}
            onPickPlanner={() => { placeWidget('planner', toWorld(menu.x, menu.y)); setMenu(null) }}
            onOpenBoard={() => { placeWidget('board', toWorld(menu.x, menu.y)); setMenu(null) }}
            onOpenAssistant={() => {
              // The assistant lives in the chat panel — it is one question of
              // "who am I talking to", not two places to look.
              setChatOpen(true)
              setAssistantRequest((n) => n + 1)
              setMenu(null)
            }}
            onClose={() => setMenu(null)}
          />
        )}
      </main>

      {boardOpen && (
        <KanbanBoard
          snapshot={coordination.snapshot}
          onCreate={(title, brief) => void coordination.createTask(title, brief)}
          onMove={(id, state) => void coordination.moveTask(id, state)}
          onDelete={(id) => {
            void confirm('Удалить задачу? Действие необратимо.', { danger: true, confirmLabel: 'Удалить' }).then((ok) => {
              if (ok) void coordination.deleteTask(id)
            })
          }}
          onResetManager={() => {
            void confirm('Сбросить роль руководителя? Любой агент сможет занять её заново.').then((ok) => {
              if (ok) void coordination.resetManager()
            })
          }}
          onReleaseLocks={() => {
            void confirm('Снять все блокировки файлов?').then((ok) => {
              if (ok) void coordination.releaseLocks()
            })
          }}
          onClose={() => setBoardOpen(false)}
        />
      )}
      {brainOpen && (
        <SecondBrain
          workspaceDir={workspaceDir}
          initialView={brainView}
          onViewChange={setBrainView}
          onClose={() => setBrainOpen(false)}
        />
      )}
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        hasStrokes={strokes.length > 0}
        onClearStrokes={() => {
          void confirm('Стереть весь рисунок? Действие необратимо.', { danger: true, confirmLabel: 'Стереть' }).then(
            (ok) => ok && canvas.clearStrokes()
          )
        }}
        onOpenChat={() => setChatOpen(true)}
        strokeColor={strokeColor}
        onStrokeColorChange={setStrokeColor}
      />
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} focusAssistant={assistantRequest} />
    </div>
  )
}

/** Runs `onMove` for the duration of a mouse drag, then cleans itself up. */
function trackDrag(onMove: (e: MouseEvent) => void): void {
  const release = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', release)
    window.removeEventListener('blur', release)
    window.removeEventListener('pointercancel', release)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', release)
  // The window can lose focus while the button is still down (alt-tab, click
  // on another window); without these the drag stays stuck until the next
  // click ever lands on the window (P2-208).
  window.addEventListener('blur', release)
  window.addEventListener('pointercancel', release)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
