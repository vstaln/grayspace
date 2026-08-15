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

/**
 * Mirror of MAX_WIDGETS in main's canvasState: the store refuses to accept a
 * 201st widget (putWidget throws, importFromRenderer slices), so a widget the
 * UI happily adds past this would stay local-only, never persist, and be
 * re-added by the merge on every broadcast — a renderer/main split that never
 * heals. Refuse the addition up front instead (CANV-07).
 */
const MAX_WIDGETS = 200

/** Default title and size per widget type, used when the caller gives none. */
const WIDGET_DEFAULTS: Record<WidgetKind, { title: string; w: number; h: number }> = {
  terminal: { title: 'Terminal', w: WIDGET_W, h: WIDGET_H },
  note: { title: 'Новая заметка', w: WIDGET_W, h: WIDGET_H },
  'git-status': { title: 'Репозиторий', w: 340, h: 260 },
  timer: { title: 'Таймер', w: 300, h: 220 },
  schedule: { title: 'Запланированные задачи', w: 400, h: 320 },
  board: { title: 'Доска задач', w: 900, h: 520 },
  planner: { title: 'Планер', w: 420, h: 520 }
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
  const hydrationRunRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceDirRef = useRef<string | null>(null)

  const hydrate = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    const run = ++hydrationRunRef.current
    hydratedRef.current = false
    skipNextSaveRef.current = true
    void window.api.canvas.load()
      .then((snapshot) => {
        if (run !== hydrationRunRef.current) return
        setWidgets(snapshot.widgets)
        setCamera(snapshot.camera)
        setStrokes(snapshot.strokes)
        setConnections([])
        const maxZ = snapshot.widgets.reduce((max, w) => Math.max(max, w.z), 0)
        zRef.current = Math.max(1, maxZ + 1)
        cascadeRef.current = 0
        // Everything the snapshot lists is acknowledged by main, so no local
        // id is awaiting its first save round-trip anymore.
        pendingCreatesRef.current.clear()
        hydratedRef.current = true
      })
      .catch(() => {
        // Load failed (IPC hiccup, store corrupt). Do NOT mark hydrated: the
        // save effect would then overwrite the stored desktop with an empty
        // one. Retry shortly instead of leaving persistence dead for the
        // session (AUD-01).
        if (run !== hydrationRunRef.current) return
        retryTimerRef.current = setTimeout(hydrate, 3000)
      })
  }, [])

  useEffect(() => {
    void window.api.workspace.getDir().then((dir) => {
      workspaceDirRef.current = dir
      hydrate()
    })
    const unbindDir = window.api.workspace.onDirChange((dir) => {
      workspaceDirRef.current = dir
      hydrate()
    })
    return () => {
      unbindDir()
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      if (strokeRafRef.current !== null) {
        cancelAnimationFrame(strokeRafRef.current)
        strokeRafRef.current = null
        strokeBatchRef.current.clear()
      }
    }
  }, [hydrate])

  useEffect(() => {
    if (!hydratedRef.current) return
    // A broadcast echo by itself needs no save-back — writing it straight back
    // to main would start an import/save feedback loop. But the echo must not
    // swallow a debounced save that still has local edits pending (a drag that
    // finished just before the broadcast, a pan, an in-flight stroke). If any
    // local change is still unsaved, fall through and schedule the save anyway
    // (CANV-02).
    const hasLocalEdits = widgetsDirtyRef.current || cameraDirtyRef.current || strokesDirtyRef.current
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      if (!hasLocalEdits) return
    }
    const timer = setTimeout(() => {
      const payload = { widgets, camera, strokes, workspaceDir: workspaceDirRef.current ?? undefined }
      widgetsDirtyRef.current = false
      cameraDirtyRef.current = false
      strokesDirtyRef.current = false
      void window.api.canvas.save(payload).catch(() => {
        // Save failed: the next edit re-saves, and a closed widget's tombstone
        // stays armed until main actually drops it — no silent data loss.
      })
    }, 800)
    return () => clearTimeout(timer)
  }, [widgets, camera, strokes])

  // Widgets the user closed locally but whose removal has not reached the
  // main process yet (the save is debounced 800ms). Any incoming snapshot that
  // still carries such an id would resurrect a deliberately closed widget —
  // for terminals that means a brand-new PTY with the same id. Keep the
  // tombstone until a save round-trip proves main dropped it (DI-004).
  const pendingDeletesRef = useRef<Set<string>>(new Set())
  // The mirror image: widgets this renderer created locally but that main has
  // not acknowledged yet (the debounced save hasn't round-tripped). Without
  // this, an incoming snapshot that simply hasn't caught up to a local
  // addition would be indistinguishable from a main-side deletion (CANV-01).
  const pendingCreatesRef = useRef<Set<string>>(new Set())

  // Keep the visible canvas in sync with MCP/assistant writes made in the main
  // process. The save echo is consumed once so an external update cannot cause
  // an import/save feedback loop.
  // Camera/strokes are edited locally (wheel-pan, pencil) and only reach main
  // after the 800ms debounce. A broadcast that lands while one of them is
  // locally dirty carries data older than what the user is looking at — the
  // pan would snap back and an in-flight stroke would have its points dropped
  // (AUD-02). Accept snapshot values only when the debounced save already
  // dispatched, so the echo matches.
  const cameraDirtyRef = useRef(false)
  const strokesDirtyRef = useRef(false)
  const widgetsDirtyRef = useRef(false)

  useEffect(() => {
    return window.api.canvas.onChange((snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.widgets)) return
      skipNextSaveRef.current = true
      setWidgets((prev) => {
        const pending = pendingDeletesRef.current
        const prevById = new Map(prev.map((w) => [w.id, w]))
        const incomingIds = new Set(snapshot.widgets.map((w) => w.id))
        // An incoming snapshot that no longer lists a tombstoned id is the
        // proof that main applied our removal — the tombstone can be dropped.
        for (const id of pending) {
          if (!incomingIds.has(id)) pending.delete(id)
        }
        if (pending.size > 0) snapshot.widgets = snapshot.widgets.filter((w) => !pending.has(w.id))
        const merged = snapshot.widgets.map((incoming) => {
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
        // Widgets that exist only on this side are kept only if they are
        // pending creates main hasn't acknowledged yet (a terminal added a
        // second ago may not have reached main's debounced save when the
        // agent's write broadcasts first). Once a pending id shows up in an
        // incoming snapshot it is acknowledged and no longer protected — a
        // later snapshot that omits it is a real main-side removal (an agent's
        // close_widget/widget.remove) and must NOT be resurrected (CANV-01).
        for (const id of pendingCreatesRef.current) {
          if (incomingIds.has(id)) pendingCreatesRef.current.delete(id)
        }
        for (const local of prev) {
          if (!incomingIds.has(local.id) && pendingCreatesRef.current.has(local.id)) merged.push(local)
        }
        return merged
      })
      if (snapshot.camera && !cameraDirtyRef.current) setCamera(snapshot.camera)
      if (Array.isArray(snapshot.strokes) && !strokesDirtyRef.current) setStrokes(snapshot.strokes)
    })
  }, [])

  const screenToWorld = useCallback((x: number, y: number, cam: Camera = cameraRef.current): Point => {
    return { x: (x - cam.x) / cam.zoom, y: (y - cam.y) / cam.zoom }
  }, [])

  const addWidget = useCallback(
    (point: Point, id: string = makeLocalId(), title?: string, kind: WidgetKind = 'terminal', noteId?: string): void => {
      const defaults = WIDGET_DEFAULTS[kind]
      // The store refuses to accept a 201st widget and slices imports to 200,
      // so a widget added past the limit would never persist and the merge
      // would re-add it forever (CANV-07). Refuse up front, inside the updater,
      // so the pending-creates bookkeeping below never happens for a widget
      // that doesn't actually get added.
      setWidgets((prev) => {
        if (prev.length >= MAX_WIDGETS) return prev
        // Main hasn't seen this widget yet; remember it so a broadcast snapshot
        // that merely hasn't caught up to it cannot be mistaken for a main-side
        // deletion (CANV-01). Cleared once the id appears in an incoming snapshot.
        pendingCreatesRef.current.add(id)
        widgetsDirtyRef.current = true
        return [
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
        ]
      })
    },
    [nextZ]
  )

  const addNoteWidget = useCallback((point: Point, noteId: string, title = 'Новая заметка'): void => {
    addWidget(point, makeLocalId('note'), title, 'note', noteId)
  }, [addWidget])

  const removeWidget = useCallback((id: string): void => {
    // Tombstone the closed id until a save round-trip proves main dropped it:
    // without this, an intermediate broadcast re-adds the widget (and for
    // terminals spawns a brand-new PTY for a shell the user just closed).
    // Cleared in onChange once the id is gone from snapshots (AUD-03).
    pendingDeletesRef.current.add(id)
    pendingCreatesRef.current.delete(id)
    widgetsDirtyRef.current = true
    setWidgets((prev) => {
      const target = prev.find((w) => w.id === id)
      // Agent/control removal skips App.closeWidget, so kill the shell here
      // when a terminal leaves the canvas permanently — otherwise park-on-detach
      // would leave Claude sessions running with no widget to reclaim them.
      if (target && (target.kind ?? 'terminal') === 'terminal') {
        window.api.terminal.dispose(id)
      }
      return prev.filter((w) => w.id !== id)
    })
    // A link to or from a closed widget describes a connection that no longer
    // exists — leaving it drawn would point at empty canvas.
    setConnections((prev) => prev.filter((c) => c.from !== id && c.to !== id))
  }, [])

  const updateWidget = useCallback((id: string, change: Partial<Widget>): void => {
    widgetsDirtyRef.current = true
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, ...change } : w)))
  }, [])

  const bringToFront = useCallback(
    (id: string): void => updateWidget(id, { z: nextZ() }),
    [nextZ, updateWidget]
  )

  /** Starts a new pencil stroke at a world point and returns its id to extend. */
  // Pencil moves fire many times per frame. Batching into rAF keeps React from
  // committing a full stroke-array rewrite on every pointer sample (PERF-draw).
  const strokeBatchRef = useRef<Map<string, Point[]>>(new Map())
  const strokeRafRef = useRef<number | null>(null)

  const beginStroke = useCallback(
    (point: Point): string => {
      const id = makeStrokeId()
      strokesDirtyRef.current = true
      setStrokes((prev) => [...prev, { id, points: [point], color: strokeColor }])
      return id
    },
    [strokeColor]
  )

  const extendStroke = useCallback((id: string, point: Point): void => {
    let queue = strokeBatchRef.current.get(id)
    if (!queue) {
      queue = []
      strokeBatchRef.current.set(id, queue)
    }
    queue.push(point)
    if (strokeRafRef.current !== null) return
    strokeRafRef.current = requestAnimationFrame(() => {
      strokeRafRef.current = null
      const batch = strokeBatchRef.current
      strokeBatchRef.current = new Map()
      if (batch.size === 0) return
      setStrokes((prev) => {
        let next: Stroke[] | null = null
        for (const [sid, points] of batch) {
          const idx = (next ?? prev).findIndex((s) => s.id === sid)
          if (idx < 0) continue
          if (!next) next = prev.slice()
          const stroke = next[idx]
          next[idx] = { ...stroke, points: stroke.points.concat(points) }
        }
        return next ?? prev
      })
    })
  }, [])

  const clearStrokes = useCallback((): void => {
    strokesDirtyRef.current = true
    setStrokes([])
  }, [])

  /**
   * Removes only the points within `radius` of a world point, splitting a
   * stroke into whatever pieces remain on either side of the gap — dragging
   * the eraser over the middle of a line erases that middle, not the whole
   * line the way a single "clear" click used to.
   */
  const eraseAt = useCallback((point: Point, radius = 14): void => {
    strokesDirtyRef.current = true
    // Radius is specified in screen px; the ink layer lives in world space
    // (scale(zoom)), so the hit-test radius must be widened as you zoom out
    // to keep the eraser footprint constant on screen (CANV-10).
    const worldRadius = radius / cameraRef.current.zoom
    setStrokes((prev) => {
      const next: Stroke[] = []
      for (const s of prev) {
        let current: Point[] = []
        for (const p of s.points) {
          if (Math.hypot(p.x - point.x, p.y - point.y) <= worldRadius) {
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

  /** Local user camera move (wheel-pan): marks the canvas dirty so a broadcast
   *  mid-pan cannot snap the view back (AUD-02). */
  const moveCamera = useCallback((next: Camera | ((prev: Camera) => Camera)): void => {
    cameraDirtyRef.current = true
    setCamera(next)
  }, [])

  return {
    widgets,
    camera,
    setCamera: moveCamera,
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
