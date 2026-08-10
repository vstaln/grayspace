import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  CanvasTool,
  Connection,
  Point,
  STROKE_COLORS,
  Stroke,
  Widget,
  WidgetKind,
  WIDGET_H,
  WIDGET_W
} from '../types'

let localCounter = 0
const makeLocalId = (kind: WidgetKind = 'terminal'): string => `${kind}-${Date.now()}-${++localCounter}`
const makeStrokeId = (): string => `stroke-${Date.now()}-${++localCounter}`

/** Default title and size per widget type, used when the caller gives none. */
const WIDGET_DEFAULTS: Record<WidgetKind, { title: string; w: number; h: number }> = {
  terminal: { title: 'Terminal', w: WIDGET_W, h: WIDGET_H },
  note: { title: 'Новая заметка', w: WIDGET_W, h: WIDGET_H },
  'git-status': { title: 'Репозиторий', w: 340, h: 260 },
  timer: { title: 'Таймер', w: 300, h: 220 },
  schedule: { title: 'Запланированные задачи', w: 400, h: 320 },
  board: { title: 'Доска задач', w: 900, h: 520 },
  planner: { title: 'Планер', w: 360, h: 440 }
}

const makeConnectionId = (): string => `conn-${Date.now()}-${++localCounter}`

/** `Terminal 3` → 3; anything else is not a numbered terminal. */
const TERMINAL_TITLE = /^Terminal (\d+)$/

/**
 * The lowest terminal number not currently on the canvas.
 *
 * Reusing a closed terminal's number is the point: a counter that only ever
 * goes up means the only terminal on an otherwise empty canvas can be called
 * "Terminal 6", which tells the user nothing except how many they have opened
 * since the app started.
 */
function nextTerminalNumber(widgets: Widget[]): number {
  const taken = new Set<number>()
  for (const widget of widgets) {
    if (widget.kind && widget.kind !== 'terminal') continue
    const match = TERMINAL_TITLE.exec(widget.title)
    if (match) taken.add(Number(match[1]))
  }
  let n = 1
  while (taken.has(n)) n += 1
  return n
}

/**
 * Owns the infinite canvas: camera, widget list, and the mapping between screen
 * and world coordinates. Also bridges widgets requested by agents over MCP.
 */
export function useCanvas() {
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [tool, setTool] = useState<CanvasTool>('select')
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [strokeColor, setStrokeColor] = useState<string>(STROKE_COLORS[0])
  const [connections, setConnections] = useState<Connection[]>([])
  const zRef = useRef(1)

  // Event subscriptions below register once, so they must never close over
  // `camera`/`widgets` directly — these refs keep them reading current state.
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  // Bumped once per agent-created widget, independent of React's render
  // cycle. `widgets.length` looked equivalent but isn't: several terminals
  // created back-to-back (an agent cascading `terminal.create`) arrive
  // faster than a render can flush, so they all read the same stale length
  // and landed on the exact same cascade offset — a pile, not a cascade.
  const cascadeRef = useRef(0)

  const nextZ = useCallback(() => ++zRef.current, [])

  // ---- persistence (DI-004) -----------------------------------------------
  // Layout and strokes are restored from disk on mount and saved back on a
  // debounce, so a restart returns the desktop the user left instead of a
  // blank canvas. Saves are skipped until hydration finishes — otherwise the
  // first effect run would overwrite the saved desktop with an empty one.
  const hydratedRef = useRef(false)
  const skipNextSaveRef = useRef(false)

  useEffect(() => {
    void window.api.canvas.load().then((snapshot) => {
      setWidgets(snapshot.widgets)
      setCamera(snapshot.camera)
      setStrokes(snapshot.strokes)
      const maxZ = snapshot.widgets.reduce((max, w) => Math.max(max, w.z), 0)
      if (maxZ >= zRef.current) zRef.current = maxZ + 1
      hydratedRef.current = true
    })
  }, [])

  useEffect(() => {
    if (!hydratedRef.current) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }
    const timer = setTimeout(() => {
      void window.api.canvas.save({ widgets, camera, strokes })
    }, 800)
    return () => clearTimeout(timer)
  }, [widgets, camera, strokes])

  // Keep the visible canvas in sync with MCP/assistant writes made in the main
  // process. The save echo is consumed once so an external update cannot cause
  // an import/save feedback loop.
  useEffect(() => {
    return window.api.canvas.onChange((snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.widgets)) return
      skipNextSaveRef.current = true
      setWidgets((prev) => {
        const prevById = new Map(prev.map((w) => [w.id, w]))
        return snapshot.widgets.map((incoming) => {
          const local = prevById.get(incoming.id)
          // A `change` broadcast fires for *any* canvas write — an agent
          // opening a terminal, another widget resizing — not just ones that
          // touch this widget. If its version hasn't moved on since we last
          // synced it, our copy wins: it may hold a drag/resize the 800ms
          // debounced save hasn't reached the main process yet, and blindly
          // taking the incoming (stale) position snapped it back mid-drag.
          if (
            local &&
            incoming.version !== undefined &&
            local.version !== undefined &&
            incoming.version <= local.version
          ) {
            return local
          }
          return incoming
        })
      })
      if (snapshot.camera) setCamera(snapshot.camera)
      if (Array.isArray(snapshot.strokes)) setStrokes(snapshot.strokes)
    })
  }, [])

  const screenToWorld = useCallback((x: number, y: number, cam: Camera = cameraRef.current): Point => {
    return { x: (x - cam.x) / cam.zoom, y: (y - cam.y) / cam.zoom }
  }, [])

  const addWidget = useCallback(
    (point: Point, id: string = makeLocalId(), title?: string, kind: WidgetKind = 'terminal', noteId?: string): void => {
      const defaults = WIDGET_DEFAULTS[kind]
      setWidgets((prev) => [
        ...prev,
        {
          id,
          // Terminal numbering fills the first gap rather than counting up
          // forever: close "Terminal 1" and the next one you open is 1 again.
          // The name describes what is on the canvas now, not how many have
          // been opened since launch.
          title: title || (kind === 'terminal' ? `Terminal ${nextTerminalNumber(prev)}` : defaults.title),
          kind,
          noteId,
          x: point.x - 16,
          y: point.y - 16,
          w: defaults.w,
          h: defaults.h,
          z: nextZ()
        }
      ])
    },
    [nextZ]
  )

  const addNoteWidget = useCallback((point: Point, noteId: string, title = 'Новая заметка'): void => {
    addWidget(point, makeLocalId('note'), title, 'note', noteId)
  }, [addWidget])

  const removeWidget = useCallback((id: string): void => {
    setWidgets((prev) => prev.filter((w) => w.id !== id))
    // A link to or from a closed widget describes a connection that no longer
    // exists — leaving it drawn would point at empty canvas.
    setConnections((prev) => prev.filter((c) => c.from !== id && c.to !== id))
  }, [])

  const updateWidget = useCallback((id: string, change: Partial<Widget>): void => {
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, ...change } : w)))
  }, [])

  const bringToFront = useCallback(
    (id: string): void => updateWidget(id, { z: nextZ() }),
    [nextZ, updateWidget]
  )

  /** Starts a new pencil stroke at a world point and returns its id to extend. */
  const beginStroke = useCallback(
    (point: Point): string => {
      const id = makeStrokeId()
      setStrokes((prev) => [...prev, { id, points: [point], color: strokeColor }])
      return id
    },
    [strokeColor]
  )

  const extendStroke = useCallback((id: string, point: Point): void => {
    setStrokes((prev) => prev.map((s) => (s.id === id ? { ...s, points: [...s.points, point] } : s)))
  }, [])

  const clearStrokes = useCallback((): void => setStrokes([]), [])

  /**
   * Removes only the points within `radius` of a world point, splitting a
   * stroke into whatever pieces remain on either side of the gap — dragging
   * the eraser over the middle of a line erases that middle, not the whole
   * line the way a single "clear" click used to.
   */
  const eraseAt = useCallback((point: Point, radius = 14): void => {
    setStrokes((prev) => {
      const next: Stroke[] = []
      for (const s of prev) {
        let current: Point[] = []
        for (const p of s.points) {
          if (Math.hypot(p.x - point.x, p.y - point.y) <= radius) {
            if (current.length > 0) next.push({ id: makeStrokeId(), points: current, color: s.color })
            current = []
          } else {
            current.push(p)
          }
        }
        if (current.length > 0) next.push({ id: makeStrokeId(), points: current, color: s.color })
      }
      return next
    })
  }, [])

  useEffect(() => {
    const offAdd = window.api.control.onAddWidget(({ id, title, from }) => {
      // Cascade agent-opened terminals instead of stacking them all at one spot,
      // and place them relative to wherever the camera currently is.
      const n = cascadeRef.current
      cascadeRef.current += 1
      const col = n % 6
      const row = Math.floor(n / 6) % 6
      addWidget(screenToWorld(90 + col * 60, 90 + row * 60), id, title)
      // `from` is the shell the request came from — draw the line that says so.
      // A dangling id (its widget already closed) draws nothing rather than an
      // arc anchored on empty canvas.
      if (from) {
        setConnections((prev) => [
          ...prev,
          { id: makeConnectionId(), from, to: id, bornAt: Date.now() }
        ])
      }
    })
    const offRemove = window.api.control.onRemoveWidget(removeWidget)
    return () => {
      offAdd()
      offRemove()
    }
  }, [addWidget, removeWidget, screenToWorld])

  return {
    widgets,
    camera,
    setCamera,
    topZ: zRef,
    screenToWorld,
    addWidget,
    addNoteWidget,
    removeWidget,
    updateWidget,
    bringToFront,
    tool,
    setTool,
    strokes,
    beginStroke,
    extendStroke,
    clearStrokes,
    eraseAt,
    strokeColor,
    setStrokeColor,
    connections
  }
}
