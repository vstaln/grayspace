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
  WIDGET_DEFAULTS
} from '../types'
import { clearTimerPersist } from '../lib/timerPersist'

let localCounter = 0
const makeLocalId = (kind: WidgetKind = 'terminal'): string => {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${kind}-${crypto.randomUUID()}` } catch {}
  return `${kind}-${Date.now()}-${++localCounter}-${Math.random().toString(36).slice(2, 6)}`
}
const makeStrokeId = (): string => {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `stroke-${crypto.randomUUID()}` } catch {}
  return `stroke-${Date.now()}-${++localCounter}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Mirror of MAX_WIDGETS in main's canvasState: the store refuses to accept a
 * 201st widget (putWidget throws, importFromRenderer slices), so a widget the
 * UI happily adds past this would stay local-only, never persist, and be
 * re-added by the merge on every broadcast — a renderer/main split that never
 * heals. Refuse the addition up front instead (CANV-07).
 */
export const MAX_WIDGETS = 200

interface StrokeBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * Axis-aligned bounds of a stroke, cached by stroke revision.
 * Keyed by `${stroke.id}:${stroke.points.length}` so IPC deserialized snapshots
 * with new object identities still hit the cache.
 */
const strokeBoundsCache = new Map<string, StrokeBounds>()
const MAX_BOUNDS_CACHE_ENTRIES = 5000

function strokeBounds(stroke: Stroke): StrokeBounds {
  const cacheKey = `${stroke.id}:${stroke.points.length}`
  const cached = strokeBoundsCache.get(cacheKey)
  if (cached) return cached
  const pts = stroke.points
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const bounds = { minX, minY, maxX, maxY }
  if (strokeBoundsCache.size >= MAX_BOUNDS_CACHE_ENTRIES) {
    const oldestKey = strokeBoundsCache.keys().next().value
    if (oldestKey) strokeBoundsCache.delete(oldestKey)
  }
  strokeBoundsCache.set(cacheKey, bounds)
  return bounds
}

/**
 * Per-widget `localStorage` keys, cleared when a widget is closed for good.
 *
 * These belong here rather than in each widget's unmount cleanup: a widget
 * unmounts whenever its frame is re-parented (maximize/restore), and a purge
 * on unmount deleted the user's saved links the moment they maximized the
 * Links widget. `removeWidget` is the one call that means "closed".
 */
const WIDGET_STORAGE_PREFIXES = [
  'orcspace-links:',
  'orcspace-music-playlists:',
  'orcspace-music-volume:',
  'orcspace-music-muted:'
] as const

/** Remove data left by the deleted canvas note widget. */
function clearRemovedNoteStorage(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (key?.startsWith('orcspace-note:')) localStorage.removeItem(key)
    }
  } catch {
    // Storage may be unavailable in a restricted profile; the feature is gone
    // regardless, so there is nothing actionable to surface to the user.
  }
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
 * and world coordinates. Also bridges widgets requested by agents over CLI / IPC.
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
  const widgetsRef = useRef(widgets)
  widgetsRef.current = widgets
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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceDirRef = useRef<string | null>(null)
  const workspaceSyncSeqRef = useRef(0)
  // A load can overlap an agent write. If a change broadcast arrives while
  // the read is in flight, applying the older read afterwards would erase the
  // freshly created or renamed widget from the renderer (stale-load race).
  const canvasChangeSeqRef = useRef(0)

  const hydrate = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    widgetsDirtyRef.current = false
    cameraDirtyRef.current = false
    strokesDirtyRef.current = false
    pendingDeletesRef.current.clear()
    pendingCreatesRef.current.clear()
    const run = ++hydrationRunRef.current
    const changesAtStart = canvasChangeSeqRef.current
    hydratedRef.current = false
    skipNextSaveRef.current = true
    void window.api.canvas.load()
      .then((snapshot) => {
        if (run !== hydrationRunRef.current) return
        if (canvasChangeSeqRef.current === changesAtStart) {
          setWidgets(snapshot.widgets)
          setCamera(snapshot.camera)
          setStrokes(snapshot.strokes)
          setConnections([])
        }
        // Seed the counter AT the restored top, not one past it. `active` is
        // decided by `w.z === topZ.current`, so starting one above meant no
        // widget was the active one after a restart — the desktop came back
        // with nothing focused until the user clicked something. `nextZ`
        // pre-increments, so a newly added widget still lands above the
        // restored stack (CANV-restore-focus).
        const maxZ = snapshot.widgets.reduce((max, w) => Math.max(max, w.z), 0)
        zRef.current = Math.max(1, maxZ)
        cascadeRef.current = 0
        // Everything the snapshot lists is acknowledged by main, so no local
        // id is awaiting its first save round-trip anymore.
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
    clearRemovedNoteStorage()
    let mounted = true
    const requestSeq = workspaceSyncSeqRef.current
    void window.api.workspace
      .getDir()
      .then((dir) => {
        if (!mounted || workspaceSyncSeqRef.current !== requestSeq) return
        workspaceDirRef.current = dir
      })
      .catch((err) => {
        console.warn('workspace:getDir failed — hydrating the default canvas anyway', err)
      })
      .finally(() => {
        // Hydration must not depend on getDir() succeeding: a rejected call
        // would otherwise leave the canvas unhydrated for the whole session.
        if (mounted && workspaceSyncSeqRef.current === requestSeq) hydrate()
      })
    const unbindDir = window.api.workspace.onDirChange((dir) => {
      if (workspaceDirRef.current === dir) return
      workspaceSyncSeqRef.current += 1
      workspaceDirRef.current = dir
      hydrate()
    })
    return () => {
      mounted = false
      workspaceSyncSeqRef.current += 1
      unbindDir()
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      // A debounced canvas.save must not fire after unmount: it would write a
      // stale snapshot over newer state on next mount's hydration race.
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (strokeRafRef.current !== null) {
        cancelAnimationFrame(strokeRafRef.current)
        strokeRafRef.current = null
        strokeBatchRef.current.clear()
      }
      if (eraseRafRef.current !== null) {
        cancelAnimationFrame(eraseRafRef.current)
        eraseRafRef.current = null
        pendingEraseRef.current = null
      }
      if (widgetRafRef.current !== null) {
        cancelAnimationFrame(widgetRafRef.current)
        widgetRafRef.current = null
        widgetPatchRef.current.clear()
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
    const dirAtSchedule = workspaceDirRef.current
    const timer = setTimeout(() => {
      saveTimerRef.current = null
      if (workspaceDirRef.current !== dirAtSchedule) return
      const payload = { widgets, camera, strokes, workspaceDir: dirAtSchedule ?? undefined }
      widgetsDirtyRef.current = false
      cameraDirtyRef.current = false
      strokesDirtyRef.current = false
      void window.api.canvas.save(payload).catch(() => {
        // Save failed: the next edit re-saves, and a closed widget's tombstone
        // stays armed until main actually drops it — no silent data loss.
      })
    }, 800)
    saveTimerRef.current = timer
    return () => {
      clearTimeout(timer)
      if (saveTimerRef.current === timer) saveTimerRef.current = null
    }
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

  // Keep the visible canvas in sync with agent/assistant writes made in the main
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
      canvasChangeSeqRef.current += 1
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
          if (local && incoming.version !== undefined && (local.version ?? 0) >= incoming.version) {
            return local
          }
          if (local && local.version === undefined && (widgetsDirtyRef.current || pendingCreatesRef.current.has(local.id))) {
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
    (point: Point, id: string = makeLocalId(), title?: string, kind: WidgetKind = 'terminal'): boolean => {
      const defaults = WIDGET_DEFAULTS[kind]
      // Cheap up-front check so the caller's boolean is correct even before
      // React runs the state updater — a functional setState is not guaranteed
      // to execute synchronously in concurrent rendering, so reading `added`
      // right after the dispatch was unreliable ("canvas full" go unnoticed,
      // widget silently staying local-only). The updater re-checks as a
      // backstop against same-tick bursts.
      // Reserve slots/ids synchronously as well as checking the rendered list.
      // Several control messages can arrive before React flushes the first
      // updater; without this guard every call reported success against the
      // same stale length and the overflow requests could create dangling
      // connection records.
      if (
        widgetsRef.current.length + pendingCreatesRef.current.size >= MAX_WIDGETS ||
        widgetsRef.current.some((widget) => widget.id === id) ||
        pendingCreatesRef.current.has(id)
      ) return false
      // Register pending create synchronously before the updater so concurrent
      // onChange that lands before React flushes the updater still sees it (COR-2).
      pendingCreatesRef.current.add(id)
      // Allocate the z-index before entering the updater. Mutating the z
      // counter from a state updater is unsafe under StrictMode, where React
      // may evaluate the updater more than once.
      const z = nextZ()
      let added = true
      setWidgets((prev) => {
        if (prev.length >= MAX_WIDGETS || prev.some((widget) => widget.id === id)) {
          // Back out the optimistic pending entry — widget never made it into state.
          pendingCreatesRef.current.delete(id)
          added = false
          return prev
        }
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
            x: point.x - 16,
            y: point.y - 16,
            w: defaults.w,
            h: defaults.h,
            z,
            version: 0
          }
        ]
      })
      return added
    },
    [nextZ]
  )

  const removeWidget = useCallback((id: string): void => {
    // Tombstone the closed id until a save round-trip proves main dropped it:
    // without this, an intermediate broadcast re-adds the widget (and for
    // terminals spawns a brand-new PTY for a shell the user just closed).
    // Cleared in onChange once the id is gone from snapshots (AUD-03).
    pendingDeletesRef.current.add(id)
    pendingCreatesRef.current.delete(id)
    widgetsDirtyRef.current = true
    // Resolve the target BEFORE dispatching: state updaters must stay pure
    // (StrictMode/concurrent re-runs would fire terminal.dispose twice). The
    // ref is render-synced, so it sees the same list the filter below removes
    // from; a widget that exists only in a not-yet-committed updater has no
    // live shell to dispose anyway.
    const target = widgetsRef.current.find((w) => w.id === id)
    // Widget ids are never reused, so a closed widget's browser-storage keys
    // are unreachable garbage — drop them here rather than from the widget's
    // own unmount, which also fires for a re-parent (maximize) and would take
    // the user's data with it. Storage is best-effort, so a failure is not
    // worth surfacing.
    for (const prefix of WIDGET_STORAGE_PREFIXES) {
      try {
        localStorage.removeItem(`${prefix}${id}`)
      } catch {
        /* private mode, quota, cleared site data — nothing to recover */
      }
    }
    if ((target?.kind ?? 'terminal') === 'timer') clearTimerPersist(id)
    if (target && (target.kind ?? 'terminal') === 'terminal') {
      // An agent holding the terminal's lock makes this reject — expected,
      // and the parked pty is reclaimed when the widget remounts.
      window.api.terminal.dispose(id).catch((err) => {
        console.warn(`terminal ${id} dispose deferred`, err)
      })
    }
    setWidgets((prev) => prev.filter((w) => w.id !== id))
    // A link to or from a closed widget describes a connection that no longer
    // exists — leaving it drawn would point at empty canvas.
    setConnections((prev) => prev.filter((c) => c.from !== id && c.to !== id))
  }, [])

  // Drag/resize fire many pointer events per frame. Batch into one React
  // commit per animation frame so the whole widget list is not rewritten
  // on every mouse sample.
  const widgetPatchRef = useRef<Map<string, Partial<Widget>>>(new Map())
  const widgetRafRef = useRef<number | null>(null)

  const updateWidget = useCallback((id: string, change: Partial<Widget>): void => {
    widgetsDirtyRef.current = true
    const pending = widgetPatchRef.current.get(id)
    widgetPatchRef.current.set(id, pending ? { ...pending, ...change } : change)
    if (widgetRafRef.current !== null) return
    widgetRafRef.current = requestAnimationFrame(() => {
      widgetRafRef.current = null
      const batch = widgetPatchRef.current
      widgetPatchRef.current = new Map()
      if (batch.size === 0) return
      setWidgets((prev) => {
        let next: Widget[] | null = null
        for (const [wid, patch] of batch) {
          const idx = (next ?? prev).findIndex((w) => w.id === wid)
          if (idx < 0) continue
          if (!next) next = prev.slice()
          next[idx] = { ...next[idx], ...patch }
        }
        return next ?? prev
      })
    })
  }, [])

  const bringToFront = useCallback(
    (id: string): void => {
      // Already the top-most widget: re-stamping its z would dirty the canvas,
      // schedule a save, journal a widget.update pair and echo a full snapshot
      // back — for a click that changed nothing. Clicking the focused pane is
      // the most common gesture on the canvas, so the no-op guard is what
      // keeps idle clicking from producing write churn (PERF-focus-noop).
      if (widgetsRef.current.find((w) => w.id === id)?.z === zRef.current) return
      updateWidget(id, { z: nextZ() })
    },
    [nextZ, updateWidget]
  )

  /** Starts a new pencil stroke at a world point and returns its id to extend.
   *  Pencil moves fire many times per frame. Batching into rAF keeps React from
   *  committing a full stroke-array rewrite on every pointer sample (PERF-draw). */
  const strokeBatchRef = useRef<Map<string, Point[]>>(new Map())
  const strokeRafRef = useRef<number | null>(null)
  // Same treatment for the eraser (PERF-erase): one rebuild per frame, latest position wins.
  const pendingEraseRef = useRef<{ point: Point; worldRadius: number } | null>(null)
  const eraseRafRef = useRef<number | null>(null)

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

  /** Drops a stroke outright — used when a pointer-down/up on the draw tool
   *  never moved enough to count as an intentional line, so it doesn't leave
   *  a stray dot behind (CANV-dot). */
  const discardStroke = useCallback((id: string): void => {
    strokeBatchRef.current.delete(id)
    strokesDirtyRef.current = true
    setStrokes((prev) => prev.filter((s) => s.id !== id))
  }, [])

  /**
   * Removes points within `radius` of a world point — directly, or via a
   * segment drawn through them (see the hit-test below) — splitting a
   * stroke into whatever pieces remain on either side of the gap — dragging
   * the eraser over the middle of a line erases that middle, not the whole
   * line the way a single "clear" click used to.
   *
   * The rebuild is batched into one animation frame like the pencil path
   * above: the erase itself walks every point of every stroke, so running it
   * once per pointer sample (a fast drag emits far more samples than frames)
   * re-did that full walk several times between two paints for nothing
   * (PERF-erase). Only the latest position per frame matters.
   */
  const eraseAt = useCallback((point: Point, radius = 14): void => {
    strokesDirtyRef.current = true
    // Radius is specified in screen px; the ink layer lives in world space
    // (scale(zoom)), so the hit-test radius must be widened as you zoom out
    // to keep the eraser footprint constant on screen (CANV-10).
    // Clamp worldRadius to avoid huge eraser at zoom 0.2 (70px) wiping half the drawing — UX-7.
    const zoom = Math.max(0.1, cameraRef.current.zoom || 1)
    const clampedRadius = Math.min(radius, 28)
    pendingEraseRef.current = { point, worldRadius: clampedRadius / zoom }
    if (eraseRafRef.current !== null) return
    eraseRafRef.current = requestAnimationFrame(() => {
      eraseRafRef.current = null
      const pending = pendingEraseRef.current
      pendingEraseRef.current = null
      if (!pending) return
      setStrokes((prev) => {
        const next: Stroke[] = []
        const near = (p: Point): boolean =>
          Math.hypot(p.x - pending.point.x, p.y - pending.point.y) <= pending.worldRadius
        // Ink is drawn BETWEEN samples (lineTo), so hit-testing stored points
        // alone let the eraser sit dead-center of a long segment of a fast
        // stroke and erase nothing. A point now also dies when an adjacent
        // segment sweeps through the eraser footprint; dropping BOTH of its
        // endpoints keeps the surviving pieces clear of the gap (UI-audit).
        const crossesFootprint = (a: Point, b: Point): boolean => {
          const dx = b.x - a.x
          const dy = b.y - a.y
          const lenSq = dx * dx + dy * dy
          const t =
            lenSq === 0
              ? 0
              : Math.max(0, Math.min(1, ((pending.point.x - a.x) * dx + (pending.point.y - a.y) * dy) / lenSq))
          return Math.hypot(pending.point.x - (a.x + t * dx), pending.point.y - (a.y + t * dy)) <= pending.worldRadius
        }
        for (const s of prev) {
          const pts = s.points
          // Cheap reject: a stroke whose bounding box does not reach the
          // eraser cannot lose a point to it, so it is passed through by
          // reference. That matters beyond the arithmetic saved — rebuilding
          // an untouched stroke with a fresh id (below) made every erase frame
          // replace the whole stroke store with structurally identical data,
          // which invalidated the ink layer's per-stroke geometry cache, made
          // main's `strokesShapeMatch` miss on every autosave, and re-wrote the
          // full canvas file for strokes nobody had touched (PERF-erase-churn).
          // A stroke that can no longer render (StrokesLayer skips anything
          // under 2 points) is dropped rather than carried forward — the same
          // rule the rebuild path below applies to its leftover tails.
          if (pts.length < 2) continue
          const bounds = strokeBounds(s)
          const r = pending.worldRadius
          if (
            bounds.maxX < pending.point.x - r ||
            bounds.minX > pending.point.x + r ||
            bounds.maxY < pending.point.y - r ||
            bounds.minY > pending.point.y + r
          ) {
            next.push(s)
            continue
          }
          const dead = new Array<boolean>(pts.length).fill(false)
          let anyDead = false
          for (let i = 0; i < pts.length; i++) {
            if (near(pts[i])) {
              dead[i] = true
              anyDead = true
            } else if (i > 0 && !dead[i - 1] && crossesFootprint(pts[i - 1], pts[i])) {
              dead[i] = true
              dead[i - 1] = true
              anyDead = true
            }
          }
          // Inside the eraser's box but nothing actually within its radius.
          if (!anyDead) {
            next.push(s)
            continue
          }
          let current: Point[] = []
          for (let i = 0; i < pts.length; i++) {
            if (dead[i]) {
              // A single leftover point renders nothing (StrokesLayer skips
              // strokes under 2 points) but would still sit in state forever
              // as a dead stroke — drop it instead of keeping that tail
              // (CANV-dot).
              if (current.length > 1) next.push({ id: makeStrokeId(), points: current, color: s.color })
              current = []
            } else {
              current.push(pts[i])
            }
          }
          if (current.length > 1) next.push({ id: makeStrokeId(), points: current, color: s.color })
        }
        return next
      })
    })
  }, [])

  useEffect(() => {
    const offAdd = window.api.control.onAddWidget(({ id, title, kind, x, y, from }) => {
      // Cascade agent-opened terminals instead of stacking them all at one spot,
      // and place them relative to wherever the camera currently is. Columns
      // cycle 0..5; rows grow forever so the 37th widget keeps cascading
      // instead of landing back on top of the first one (CANV-17).
      const n = cascadeRef.current
      cascadeRef.current += 1
      const col = n % 6
      const row = Math.floor(n / 6)
      const point = kind && typeof x === 'number' && typeof y === 'number'
        ? { x, y }
        : screenToWorld(90 + col * 60, 90 + row * 60)
      // Old callers could still send the removed note kind. Ignore unknown
      // widget requests instead of turning them into a broken local frame.
      const requestedKind = typeof kind === 'string' ? kind : undefined
      if (requestedKind === 'note' || (requestedKind && !(requestedKind in WIDGET_DEFAULTS))) return
      const added = addWidget(point, id, title, (requestedKind as WidgetKind | undefined) ?? 'terminal')
      // `from` is the shell the request came from — draw the line that says so.
      // A dangling id (its widget already closed) draws nothing rather than an
      // arc anchored on empty canvas. `addWidget` refusing (canvas at
      // MAX_WIDGETS) leaves no widget that could ever trigger removeWidget's
      // connection cleanup — pushing one here anyway would leak a Connection
      // into state for the rest of the session, forever.
      if (added && from) {
        setConnections((prev) => [
          ...prev,
          { id: makeConnectionId(), from, to: id, bornAt: Date.now() }
        ])
      }
    })
    const offRemove = window.api.control.onRemoveWidget(removeWidget)
    const offRename = window.api.control.onRenameWidget(({ id, title }) => {
      setWidgets((prev) => prev.map((widget) => (widget.id === id ? { ...widget, title } : widget)))
    })
    return () => {
      offAdd()
      offRemove()
      offRename()
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
    removeWidget,
    updateWidget,
    bringToFront,
    tool,
    setTool,
    strokes,
    beginStroke,
    extendStroke,
    clearStrokes,
    discardStroke,
    eraseAt,
    strokeColor,
    setStrokeColor,
    connections
  }
}
