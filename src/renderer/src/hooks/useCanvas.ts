import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  CanvasTool,
  Connection,
  NON_MAXIMIZABLE,
  Point,
  STROKE_COLORS,
  Stroke,
  Widget,
  WidgetKind,
  WIDGET_DEFAULTS
} from '../types'
import { clearTimerPersist } from '../lib/timerPersist'
import { clearInitialCommand } from '../lib/pendingTerminalCommands'
import { applyDeltaToWidgets } from '../lib/canvasDeltaMerge'
import { fitSpawnSize } from '../lib/canvasLayout'
import type { CanvasDelta } from '../../../preload/api'
import { pickTerminalName } from '../../../main/terminalNames.ts'

let localCounter = 0
const makeLocalId = (kind: WidgetKind = 'terminal'): string => {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${kind}-${crypto.randomUUID()}` } catch {}
  return `${kind}-${Date.now()}-${++localCounter}-${Math.random().toString(36).slice(2, 6)}`
}
const makeStrokeId = (): string => {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `stroke-${crypto.randomUUID()}` } catch {}
  return `stroke-${Date.now()}-${++localCounter}-${Math.random().toString(36).slice(2, 6)}`
}








export const MAX_WIDGETS = 200

interface StrokeBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}






const strokeBoundsCache = new Map<string, StrokeBounds>()
const MAX_BOUNDS_CACHE_ENTRIES = 5000

function strokeBounds(stroke: Stroke): StrokeBounds {
  const pts = stroke.points
  const first = pts[0]
  const last = pts[pts.length - 1]
  const cacheKey = `${stroke.id}:${pts.length}:${first ? `${first.x},${first.y}` : ''}:${last ? `${last.x},${last.y}` : ''}`
  const cached = strokeBoundsCache.get(cacheKey)
  if (cached) return cached
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
 * Every localStorage key namespaced by widget id, cleared when that widget is
 * removed. The browser entries are shared by canvas widgets and Code browser
 * sessions; the hydration sweep below keeps both kinds of live ids.
 *
 * That matters beyond the wasted space: localStorage has a hard quota, and
 * every write in this app is wrapped in `try {} catch {}`. Once the quota is
 * reached the throw is swallowed and *all* widget persistence silently stops
 * working, with nothing on screen to say why. Anything that starts writing a
 * per-widget key belongs in this list.
 */
/**
 * Per-widget keys that can be swept when their owner is absent from both the
 * canvas snapshot and the Code-session snapshot.
 */
const PRUNABLE_WIDGET_PREFIXES = [
  'orcspace-links:',
  'orcspace-music-playlists:',
  // MusicPlayerWidget writes the playlist/track cursor under its own prefix,
  // and it was the one per-widget key this list never learned about: closing a
  // music player left the entry behind, and the hydration sweep below skipped
  // it too, so it survived for the life of the install.
  'orcspace-music-index:',
  'orcspace-music-volume:',
  'orcspace-music-muted:',
  'orcspace-browser-url:',
  'orcspace-browser-media:',
  'orcspace-chat:messages:',
  'orcspace-chat:config:',
  // Cleared by name in removeWidget below, but only when the widget is still
  // in `widgetsRef` at that moment. Listing it here also sweeps entries left
  // by earlier installs, and both widgets are canvas-only (WidgetFrame is
  // rendered from App alone), so "not on the canvas" is proof of garbage.
  'orcspace-timer:'
] as const

/**
 * Written by WidgetFrame for both canvas widgets and Code sessions.
 *
 * Removing one widget clears its own keys by id, which is always correct. They
 * are kept out of the prunable set above because a Code session is not a canvas
 * widget: sweeping these by "not on the canvas" would wipe the agent selection
 * of every open Code session on the next hydration.
 */
const AGENT_STORAGE_PREFIXES = [
  'orcspace-agent-select:',
  'orcspace-attach:',
  'orcspace-launched-agent:'
] as const

/**
 * Everything `removeWidget` clears for the widget going away. `closeWidget` in
 * App also clears the agent keys through `forgetAgentSelection`, but that is
 * only the interactive path — a widget removed through `orc` arrives here
 * instead, and used to leave all three behind for good.
 */
const WIDGET_STORAGE_PREFIXES = [...PRUNABLE_WIDGET_PREFIXES, ...AGENT_STORAGE_PREFIXES] as const


/**
 * Drop per-widget storage whose widget is no longer on the canvas.
 *
 * `removeWidget` clears these keys going forward, but installs that ran before
 * the browser prefixes were listed there still carry old entries. Runs once
 * per hydration against the freshly loaded canvas and Code owner sets, which
 * is the only point where an entry can be classified as orphaned safely.
 */
function pruneOrphanWidgetStorage(liveStorageIds: Set<string>): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (!key) continue
      const prefix = PRUNABLE_WIDGET_PREFIXES.find((candidate) => key.startsWith(candidate))
      if (!prefix) continue
      if (!liveStorageIds.has(key.slice(prefix.length))) localStorage.removeItem(key)
    }
  } catch {

  }
}

function clearRemovedNoteStorage(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (key?.startsWith('orcspace-note:')) localStorage.removeItem(key)
    }
  } catch {


  }
}

const makeConnectionId = (): string => `conn-${Date.now()}-${++localCounter}`


interface UseCanvasOptions {
  favoriteTerminalNames?: string[]
}

export interface WidgetMediaMetadata {
  imagePath?: string
  imageName?: string
}









export function useCanvas({ favoriteTerminalNames = [] }: UseCanvasOptions = {}) {
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [tool, setTool] = useState<CanvasTool>('select')
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [strokeColor, setStrokeColor] = useState<string>(STROKE_COLORS[0])
  const [connections, setConnections] = useState<Connection[]>([])
  const zRef = useRef(1)



  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const widgetsRef = useRef(widgets)
  widgetsRef.current = widgets
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections
  const lastDeltaSeqRef = useRef(0)
  const suppressedWidgetIdsRef = useRef<Set<string>>(new Set())

  const suppressWidget = useCallback((id: string, suppressed: boolean): void => {
    if (suppressed) {
      suppressedWidgetIdsRef.current.add(id)
    } else {
      suppressedWidgetIdsRef.current.delete(id)
    }
  }, [])

  type CanvasHistorySnapshot = {
    widgets: Widget[]
    strokes: Stroke[]
    connections: Connection[]
  }
  const historyPastRef = useRef<CanvasHistorySnapshot[]>([])
  const historyFutureRef = useRef<CanvasHistorySnapshot[]>([])
  const historyReadyRef = useRef(false)
  const historyCoalesceRef = useRef<{ key: string; at: number } | null>(null)

  const emitHistoryState = useCallback((): void => {
    window.dispatchEvent(new CustomEvent('orcspace:canvas-history', {
      detail: {
        canUndo: historyPastRef.current.length > 0,
        canRedo: historyFutureRef.current.length > 0
      }
    }))
  }, [])

  const captureHistorySnapshot = useCallback((): CanvasHistorySnapshot => ({
    widgets: widgetsRef.current.map((widget) => ({ ...widget })),
    strokes: strokesRef.current.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) })),
    connections: connectionsRef.current.map((connection) => ({ ...connection }))
  }), [])

  const recordHistory = useCallback((key = 'canvas'): void => {
    if (!historyReadyRef.current) return
    const now = Date.now()
    const previous = historyCoalesceRef.current
    if (previous && previous.key === key && now - previous.at < 500) {
      previous.at = now
      return
    }
    historyPastRef.current.push(captureHistorySnapshot())
    if (historyPastRef.current.length > 100) historyPastRef.current.shift()
    historyFutureRef.current = []
    historyCoalesceRef.current = { key, at: now }
    emitHistoryState()
  }, [captureHistorySnapshot, emitHistoryState])





  const cascadeRef = useRef(0)

  const nextZ = useCallback(() => ++zRef.current, [])






  const hydratedRef = useRef(false)
  const skipNextSaveRef = useRef(false)
  const hydrationRunRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceDirRef = useRef<string | null>(null)
  const workspaceSyncSeqRef = useRef(0)
  const widgetPatchRef = useRef<Map<string, Partial<Widget>>>(new Map())
  const widgetRafRef = useRef<number | null>(null)



  const canvasChangeSeqRef = useRef(0)

  const pendingWidgetsSnapshot = useCallback((): Widget[] => {
    const batch = widgetPatchRef.current
    if (batch.size === 0) return widgetsRef.current
    const next = widgetsRef.current.map((widget) => {
      const patch = batch.get(widget.id)
      return patch ? { ...widget, ...patch } : widget
    })
    widgetsRef.current = next
    return next
  }, [])

  function resetCanvasHistory(): void {
    historyPastRef.current = []
    historyFutureRef.current = []
    historyCoalesceRef.current = null
    historyReadyRef.current = true
    emitHistoryState()
  }

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
    dirtyWidgetIdsRef.current.clear()
    cameraDirtyRef.current = false
    strokesDirtyRef.current = false
    connectionsDirtyRef.current = false
    pendingDeletesRef.current.clear()
    pendingCreatesRef.current.clear()
    const run = ++hydrationRunRef.current
    const changesAtStart = canvasChangeSeqRef.current
    hydratedRef.current = false
    skipNextSaveRef.current = true
    const codeLoad = typeof window.api.code?.load === 'function'
      ? window.api.code.load().catch(() => null)
      : Promise.resolve(null)
    void Promise.all([window.api.canvas.load(), codeLoad])
      .then(([snapshot, codeSnapshot]) => {
        if (run !== hydrationRunRef.current) return
        if (canvasChangeSeqRef.current === changesAtStart) {
          setWidgets(snapshot.widgets)
          setCamera(snapshot.camera)
          setStrokes(snapshot.strokes)
          setConnections(snapshot.connections ?? [])
          widgetsRef.current = snapshot.widgets
          strokesRef.current = snapshot.strokes
          connectionsRef.current = snapshot.connections ?? []
          // Only inside this branch: when local changes have already raced
          // ahead of the load, the snapshot is stale and its widget list
          // would read a just-created widget as an orphan and delete the
          // storage it is about to use.
          const liveStorageIds = new Set(snapshot.widgets.map((w) => w.id))
          // Code browser sessions use the same per-widget browser storage as
          // canvas browser widgets, but their ids are not in the canvas
          // snapshot. Keep those ids live during the canvas sweep or a
          // workspace hydration will erase their URL and dropped media.
          if (codeSnapshot && Array.isArray(codeSnapshot.sessions)) {
            for (const session of codeSnapshot.sessions) {
              if (session && typeof session.id === 'string') liveStorageIds.add(session.id)
            }
          }
          pruneOrphanWidgetStorage(liveStorageIds)
        }

        const maxZ = snapshot.widgets.reduce((max, w) => Math.max(max, w.z), 0)
        zRef.current = Math.max(1, maxZ)
        cascadeRef.current = 0
        resetCanvasHistory()


        hydratedRef.current = true
        if (snapshot.snapshotSeq) {
          lastDeltaSeqRef.current = Math.max(lastDeltaSeqRef.current, snapshot.snapshotSeq)
        }
        // The snapshot above predates anything committed while load() was in
        // flight: replay from our cursor and apply what we missed instead of
        // only bumping the cursor (which would drop those events forever).
        catchUpDeltas(run)
      })
      .catch(() => {




        if (run !== hydrationRunRef.current) return
        retryTimerRef.current = setTimeout(hydrate, 3000)
      })
  }, [])

  // Applies one journal delta to local state. Deltas are a read-only fast
  // path: the debounced canvas.save remains the single mutation gate, so this
  // never writes back and never records history.
  const applyIncomingDelta = useCallback((delta: CanvasDelta): void => {
    if (!hydratedRef.current || !delta) return
    // The journal is global across folders: traffic from another workspace
    // must never rewrite this board.
    if ((delta.workspaceDir ?? null) !== (workspaceDirRef.current ?? null)) return
    if (delta.seq <= lastDeltaSeqRef.current) return
    lastDeltaSeqRef.current = delta.seq
    const { patch } = delta
    if (patch.op === 'upsert' || patch.op === 'update' || patch.op === 'remove') {
      // Echoes of our own not-yet-acked creates/deletes: acknowledge first.
      if (patch.op === 'upsert' && pendingCreatesRef.current.has(patch.widget.id)) {
        pendingCreatesRef.current.delete(patch.widget.id)
      }
      if (patch.op === 'remove' && pendingDeletesRef.current.has(patch.id)) {
        pendingDeletesRef.current.delete(patch.id)
      }
      const context = {
        dirtyWidgetIds: dirtyWidgetIdsRef.current,
        pendingCreates: pendingCreatesRef.current,
        pendingDeletes: pendingDeletesRef.current,
        suppressedWidgetIds: suppressedWidgetIdsRef.current
      }
      setWidgets((prev) => applyDeltaToWidgets(prev, delta, context))
      return
    }
    if (patch.op === 'replace') {
      const value: unknown = patch.value
      if (value && typeof value === 'object' && 'x' in value && 'y' in value && 'zoom' in value) {
        if (!cameraDirtyRef.current) setCamera(value as Camera)
        return
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return
        const first = value[0] as Record<string, unknown> | null
        if (first && typeof first === 'object' && 'points' in first) {
          if (!strokesDirtyRef.current) setStrokes(value as Stroke[])
          return
        }
        if (first && typeof first === 'object' && 'from' in first) {
          if (!connectionsDirtyRef.current) setConnections(value as Connection[])
          return
        }
        return
      }
      if (value && typeof value === 'object' && Array.isArray((value as { widgets?: unknown }).widgets)) {
        // Import/transaction snapshot: wholesale take is only safe with
        // nothing unsaved locally, otherwise our pending save supersedes it.
        const hasLocalEdits =
          widgetsDirtyRef.current || cameraDirtyRef.current ||
          strokesDirtyRef.current || connectionsDirtyRef.current ||
          dirtyWidgetIdsRef.current.size > 0 || pendingCreatesRef.current.size > 0 ||
          pendingDeletesRef.current.size > 0 || widgetPatchRef.current.size > 0
        if (!hasLocalEdits) hydrate()
      }
    }
  }, [hydrate])

  // Replays missed journal events after hydrate or reconnect. Moves the cursor
  // past a truncated ring instead of walking it; the fresh snapshot (or the
  // onChange full-sync fallback) already covers that state.
  const catchUpDeltas = useCallback((run?: number): void => {
    if (!hydratedRef.current || !window.api.canvas?.replay) return
    const baseline = lastDeltaSeqRef.current
    void window.api.canvas.replay(baseline).then((rep) => {
      if (run !== undefined && run !== hydrationRunRef.current) return
      if (!hydratedRef.current) return
      if (!rep || !Array.isArray(rep.events)) return
      if (rep.resetRequired) {
        if (typeof rep.lastSeq === 'number') {
          lastDeltaSeqRef.current = Math.max(lastDeltaSeqRef.current, rep.lastSeq)
        }
        return
      }
      for (const evt of rep.events) applyIncomingDelta(evt)
      if (typeof rep.lastSeq === 'number') {
        lastDeltaSeqRef.current = Math.max(lastDeltaSeqRef.current, rep.lastSeq)
      }
    }).catch(() => {})
  }, [applyIncomingDelta])

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


        if (mounted && workspaceSyncSeqRef.current === requestSeq) hydrate()
      })
    const unbindDir = window.api.workspace.onDirChange((dir) => {
      if (workspaceDirRef.current === dir) return
      const previousDir = workspaceDirRef.current
      const hasLocalEdits =
        widgetsDirtyRef.current || cameraDirtyRef.current || strokesDirtyRef.current || connectionsDirtyRef.current ||
        dirtyWidgetIdsRef.current.size > 0 || pendingCreatesRef.current.size > 0 ||
        pendingDeletesRef.current.size > 0 || widgetPatchRef.current.size > 0
      if (widgetRafRef.current !== null) {
        cancelAnimationFrame(widgetRafRef.current)
        widgetRafRef.current = null
      }
      const widgetsForPreviousWorkspace = pendingWidgetsSnapshot()
      if (hasLocalEdits) {
        const payload = {
          // updateWidget/toggleMaximize batch React state in a RAF. Include
          // that pending batch before switching slots so the last drag is not
          // persisted to neither workspace.
          widgets: widgetsForPreviousWorkspace,
          camera: cameraRef.current,
          strokes: strokesRef.current,
          connections: connectionsRef.current,
          workspaceDir: previousDir ?? undefined
        }
        void window.api.canvas.save(payload).catch((err) => console.warn('failed to preserve canvas before workspace switch', err))
      }
      // The batch belongs to the old workspace. Do not let hydrate's new slot
      // inherit it after the old snapshot has been queued for persistence.
      widgetPatchRef.current.clear()
      workspaceSyncSeqRef.current += 1
      workspaceDirRef.current = dir
      hydrate()
    })
    return () => {
      mounted = false
      workspaceSyncSeqRef.current += 1
      hydrationRunRef.current += 1
      unbindDir()
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }


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
  }, [hydrate, pendingWidgetsSnapshot])

  useEffect(() => {
    if (!hydratedRef.current) return






    const hasLocalEdits = widgetsDirtyRef.current || cameraDirtyRef.current || strokesDirtyRef.current || connectionsDirtyRef.current
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      if (!hasLocalEdits) return
    }
    const dirAtSchedule = workspaceDirRef.current
    const timer = setTimeout(() => {
      saveTimerRef.current = null
      if (workspaceDirRef.current !== dirAtSchedule) return
      const payload = { widgets, camera, strokes, connections, workspaceDir: dirAtSchedule ?? undefined }
      widgetsDirtyRef.current = false
      dirtyWidgetIdsRef.current.clear()
      cameraDirtyRef.current = false
      strokesDirtyRef.current = false
      connectionsDirtyRef.current = false
      void window.api.canvas.save(payload).catch(() => {


      })
    }, 800)
    saveTimerRef.current = timer
    return () => {
      clearTimeout(timer)
      if (saveTimerRef.current === timer) saveTimerRef.current = null
    }
  }, [widgets, camera, strokes, connections])






  const pendingDeletesRef = useRef<Set<string>>(new Set())




  const pendingCreatesRef = useRef<Set<string>>(new Set())










  const cameraDirtyRef = useRef(false)
  const strokesDirtyRef = useRef(false)
  const connectionsDirtyRef = useRef(false)
  const widgetsDirtyRef = useRef(false)
  /**
   * Which widgets carry unsaved local edits. The merge below used the single
   * `widgetsDirtyRef` boolean for this, so dragging one widget marked the whole
   * canvas dirty and every incoming update — for widgets the user was nowhere
   * near — was discarded until the next save 800ms later. Renames and moves
   * made by other agents through `orc` simply vanished.
   */
  const dirtyWidgetIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    return window.api.canvas.onChange((snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.widgets)) return
      canvasChangeSeqRef.current += 1
      skipNextSaveRef.current = true
      const pending = new Set(pendingDeletesRef.current)
      const incomingIds = new Set(snapshot.widgets.map((w) => w.id))
      for (const id of pending) {
        if (!incomingIds.has(id)) pendingDeletesRef.current.delete(id)
      }
      const list = pending.size > 0 ? snapshot.widgets.filter((w) => !pending.has(w.id)) : snapshot.widgets
      setWidgets((prev) => {
        const prevById = new Map(prev.map((w) => [w.id, w]))
        const merged = list.map((incoming) => {
          const local = prevById.get(incoming.id)






          if (local && incoming.version !== undefined && (local.version ?? 0) >= incoming.version) {
            return local
          }
          if (local && local.version === undefined && (dirtyWidgetIdsRef.current.has(local.id) || pendingCreatesRef.current.has(local.id))) {
            return local
          }
          return incoming
        })







        const created = new Set(pendingCreatesRef.current)
        for (const local of prev) {
          if (!incomingIds.has(local.id) && created.has(local.id)) merged.push(local)
        }
        return merged
      })
      for (const id of pendingCreatesRef.current) {
        if (incomingIds.has(id)) pendingCreatesRef.current.delete(id)
      }
      if (snapshot.camera && !cameraDirtyRef.current) setCamera(snapshot.camera)
      if (Array.isArray(snapshot.strokes) && !strokesDirtyRef.current) setStrokes(snapshot.strokes)
      if (Array.isArray(snapshot.connections) && !connectionsDirtyRef.current) setConnections(snapshot.connections)
    })
  }, [])

  useEffect(() => {
    if (!window.api.canvas?.onDelta) return
    return window.api.canvas.onDelta((delta) => applyIncomingDelta(delta))
  }, [applyIncomingDelta])

  useEffect(() => {
    const onFocus = (): void => catchUpDeltas()
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
    }
  }, [catchUpDeltas])

  const screenToWorld = useCallback((x: number, y: number, cam: Camera = cameraRef.current): Point => {
    return { x: (x - cam.x) / cam.zoom, y: (y - cam.y) / cam.zoom }
  }, [])

  const addWidget = useCallback(
    (point: Point, id: string = makeLocalId(), title?: string, kind: WidgetKind = 'terminal', media?: WidgetMediaMetadata): boolean => {
      const defaults = WIDGET_DEFAULTS[kind]











      if (
        widgetsRef.current.length + pendingCreatesRef.current.size >= MAX_WIDGETS ||
        widgetsRef.current.some((widget) => widget.id === id) ||
        pendingCreatesRef.current.has(id)
      ) return false


      recordHistory(`add:${id}`)
      pendingCreatesRef.current.add(id)



      const z = nextZ()
      const current = widgetsRef.current
      if (current.length >= MAX_WIDGETS || current.some((widget) => widget.id === id)) {
        pendingCreatesRef.current.delete(id)
        return false
      }
      widgetsDirtyRef.current = true
      dirtyWidgetIdsRef.current.add(id)
      const widgetTitle = title || (kind === 'terminal'
        ? pickTerminalName({
          favorites: favoriteTerminalNames,
          taken: current.filter((widget) => !widget.kind || widget.kind === 'terminal').map((widget) => widget.title)
        })
        : defaults.title)
      // A fresh widget opens fully inside the visible area: on a small app
      // window the kind default would spawn cropped. On roomy viewports this
      // is exactly the default, so existing behaviour does not change.
      const spawnSize = fitSpawnSize(kind, window.innerWidth, window.innerHeight, cameraRef.current.zoom)
      const widget: Widget = {
        id,
        title: widgetTitle,
        kind,
        x: point.x - 16,
        y: point.y - 16,
        w: spawnSize.w,
        h: spawnSize.h,
        z,
        version: 0,
        ...(media?.imagePath ? { imagePath: media.imagePath } : {}),
        ...(media?.imageName ? { imageName: media.imageName } : {})
      }
      // Keep the synchronous ref ahead of React's queued updater. Workspace
      // changes can arrive before the updater or the persistence debounce.
      widgetsRef.current = [...current, widget]
      setWidgets((prev) => {
        if (prev.some((widget) => widget.id === id)) return prev
        return [...prev, widget]
      })
      return true
    },
    [favoriteTerminalNames, nextZ, recordHistory]
  )


  const removeWidget = useCallback((id: string): void => {




    pendingDeletesRef.current.add(id)
    recordHistory(`remove:${id}`)
    pendingCreatesRef.current.delete(id)
    widgetsDirtyRef.current = true
    dirtyWidgetIdsRef.current.add(id)





    const target = widgetsRef.current.find((w) => w.id === id)





    for (const prefix of WIDGET_STORAGE_PREFIXES) {
      try {
        localStorage.removeItem(`${prefix}${id}`)
      } catch {

      }
    }
    // A launch command that never made it to the pty must not outlive the
    // widget it was meant for.
    clearInitialCommand(id)
    if ((target?.kind ?? 'terminal') === 'timer') clearTimerPersist(id)
    if (target && (target.kind ?? 'terminal') === 'terminal') {


      window.api.terminal.dispose(id).catch((err) => {
        console.warn(`terminal ${id} dispose deferred`, err)
      })
    }
    widgetsRef.current = widgetsRef.current.filter((widget) => widget.id !== id)
    setWidgets((prev) => prev.filter((w) => w.id !== id))


    connectionsDirtyRef.current = true
    setConnections((prev) => prev.filter((c) => c.from !== id && c.to !== id))
  }, [recordHistory])




  /** The widget write itself; history is the caller's business. */
  const applyWidgetPatch = useCallback((id: string, change: Partial<Widget>): void => {
    widgetsDirtyRef.current = true
    dirtyWidgetIdsRef.current.add(id)
    const currentWidget = widgetsRef.current.find((w) => w.id === id)
    const baseVersion = currentWidget?.version

    // Nothing goes out per packet while a gesture owns this widget.
    //
    // Suppression also stops incoming upserts from being merged, so the local
    // `version` stops advancing the moment a gesture starts — while the server
    // bumps it on every write it accepts. A resize commits on every mousemove,
    // so from the second packet on, every one of them carried a baseVersion
    // the server had already moved past: a conflict, rejected, and swallowed
    // by the `catch` below. An entire drag's worth of IPC round trips existed
    // to have all but the first rejected.
    //
    // The geometry is not lost by skipping them — the debounced full-snapshot
    // save persists the settled result, and the header drag already commits
    // once on release, after unsuppressing. This only stops the traffic that
    // was never going to be applied.
    if (window.api.canvas?.updateWidget && !suppressedWidgetIdsRef.current.has(id)) {
      void window.api.canvas.updateWidget(id, change, baseVersion).catch(() => {})
    }

    const pending = widgetPatchRef.current.get(id)
    widgetPatchRef.current.set(id, pending ? { ...pending, ...change } : change)
    widgetsRef.current = widgetsRef.current.map((widget) => widget.id === id ? { ...widget, ...change } : widget)
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

  const updateWidget = useCallback((id: string, change: Partial<Widget>): void => {
    recordHistory(`widget:${id}`)
    applyWidgetPatch(id, change)
  }, [applyWidgetPatch, recordHistory])

  /**
   * Moves or resizes many widgets as one edit: a canvas-wide arrange must be a
   * single Undo step, not one per widget.
   */
  const updateWidgets = useCallback((
    patches: ReadonlyArray<{ id: string; change: Partial<Widget> }>,
    historyKey = 'canvas'
  ): void => {
    if (patches.length === 0) return
    recordHistory(historyKey)
    for (const patch of patches) applyWidgetPatch(patch.id, patch.change)
  }, [applyWidgetPatch, recordHistory])

  const bringToFront = useCallback(
    (id: string): void => {





      // `widgetsRef` only catches up on render, and updateWidget defers its
      // patch to a RAF, so consulting it alone made every click in a rapid
      // series look like the widget was still behind — each one burned another
      // z value.
      const currentZ = widgetPatchRef.current.get(id)?.z ?? widgetsRef.current.find((w) => w.id === id)?.z
      if (currentZ === zRef.current) return
      updateWidget(id, { z: nextZ() })
    },
    [nextZ, updateWidget]
  )

  // Single-writer toggle for maximize. App's old version read widgetsRef
  // (stale until the next render) and issued separate batches, so two fast
  // clicks read the same maximized=false and left the widget stuck maximized.
  // This consults the pending RAF batch first and commits maximize +
  // un-maximize-others + bring-to-front in one batch, so rapid toggles alternate.
  const toggleMaximize = useCallback(
    (id: string): void => {
      const target = widgetsRef.current.find((w) => w.id === id)
      if (!target) return
      if (NON_MAXIMIZABLE.has((target.kind ?? 'terminal') as WidgetKind)) return
      const pendingTarget = widgetPatchRef.current.get(id)
      const currentlyMaximized = pendingTarget?.maximized ?? target.maximized === true
      const next = !currentlyMaximized
      recordHistory(`widget:${id}`)
      widgetsDirtyRef.current = true
      dirtyWidgetIdsRef.current.add(id)
      const mergePatch = (wid: string, patch: Partial<Widget>): void => {
        const prev = widgetPatchRef.current.get(wid)
        widgetPatchRef.current.set(wid, prev ? { ...prev, ...patch } : patch)
      }
      for (const other of widgetsRef.current) {
        if (other.id === id) continue
        const pendingOther = widgetPatchRef.current.get(other.id)
        const otherMaximized = pendingOther?.maximized ?? other.maximized === true
        if (otherMaximized) {
          dirtyWidgetIdsRef.current.add(other.id)
          mergePatch(other.id, { maximized: false })
        }
      }
      mergePatch(id, { maximized: next, z: nextZ() })
      pendingWidgetsSnapshot()
      if (widgetRafRef.current !== null) return
      widgetRafRef.current = requestAnimationFrame(() => {
        widgetRafRef.current = null
        const batch = widgetPatchRef.current
        widgetPatchRef.current = new Map()
        if (batch.size === 0) return
        setWidgets((prev) => {
          let nextWidgets: Widget[] | null = null
          for (const [wid, patch] of batch) {
            const idx = (nextWidgets ?? prev).findIndex((w) => w.id === wid)
            if (idx < 0) continue
            if (!nextWidgets) nextWidgets = prev.slice()
            nextWidgets[idx] = { ...nextWidgets[idx], ...patch }
          }
          return nextWidgets ?? prev
        })
      })
    },
    [nextZ, pendingWidgetsSnapshot, recordHistory]
  )




  const strokeBatchRef = useRef<Map<string, Point[]>>(new Map())
  const strokeRafRef = useRef<number | null>(null)

  const pendingEraseRef = useRef<{ point: Point; worldRadius: number } | null>(null)
  const eraseRafRef = useRef<number | null>(null)

  const beginStroke = useCallback(
    (point: Point): string => {
      const id = makeStrokeId()
      recordHistory(`stroke:${id}`)
      strokesDirtyRef.current = true
      setStrokes((prev) => [...prev, { id, points: [point], color: strokeColor }])
      return id
    },
    [recordHistory, strokeColor]
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
    if (strokesRef.current.length === 0) return
    recordHistory('clear-strokes')
    strokesDirtyRef.current = true
    setStrokes([])
  }, [recordHistory])




  const discardStroke = useCallback((id: string): void => {
    if (!strokesRef.current.some((stroke) => stroke.id === id)) return
    recordHistory(`discard-stroke:${id}`)
    strokeBatchRef.current.delete(id)
    strokesDirtyRef.current = true
    setStrokes((prev) => prev.filter((s) => s.id !== id))
  }, [recordHistory])














  const eraseAt = useCallback((point: Point, radius = 14): void => {
    recordHistory('erase-stroke')
    strokesDirtyRef.current = true




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











          // A dot — a click with no drag — is a one-point stroke the user can
          // see. Skipping it here dropped it from `next` entirely, so erasing
          // anywhere on the canvas silently deleted every dot on it.
          if (pts.length === 0) continue
          if (pts.length === 1) {
            if (!near(pts[0])) next.push(s)
            continue
          }
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

          if (!anyDead) {
            next.push(s)
            continue
          }
          let current: Point[] = []
          for (let i = 0; i < pts.length; i++) {
            if (dead[i]) {




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
  }, [recordHistory])

  const restoreHistorySnapshot = useCallback((snapshot: CanvasHistorySnapshot): void => {
    const targetIds = new Set(snapshot.widgets.map((widget) => widget.id))
    for (const widget of widgetsRef.current) {
      if (!targetIds.has(widget.id) && (!widget.kind || widget.kind === 'terminal')) {
        void window.api.terminal.dispose(widget.id).catch(() => {})
      }
    }
    if (widgetRafRef.current !== null) {
      cancelAnimationFrame(widgetRafRef.current)
      widgetRafRef.current = null
    }
    widgetPatchRef.current.clear()
    strokeBatchRef.current.clear()
    pendingEraseRef.current = null
    if (strokeRafRef.current !== null) {
      cancelAnimationFrame(strokeRafRef.current)
      strokeRafRef.current = null
    }
    if (eraseRafRef.current !== null) {
      cancelAnimationFrame(eraseRafRef.current)
      eraseRafRef.current = null
    }
    pendingDeletesRef.current.clear()
    pendingCreatesRef.current.clear()
    widgetsRef.current = snapshot.widgets
    strokesRef.current = snapshot.strokes
    connectionsRef.current = snapshot.connections
    zRef.current = Math.max(1, ...snapshot.widgets.map((widget) => widget.z))
    setWidgets(snapshot.widgets)
    setStrokes(snapshot.strokes)
    setConnections(snapshot.connections)
    widgetsDirtyRef.current = true
    strokesDirtyRef.current = true
    connectionsDirtyRef.current = true
  }, [])

  const undoCanvas = useCallback((): void => {
    const target = historyPastRef.current.pop()
    if (!target) return
    historyFutureRef.current.push(captureHistorySnapshot())
    historyCoalesceRef.current = null
    restoreHistorySnapshot(target)
    emitHistoryState()
  }, [captureHistorySnapshot, emitHistoryState, restoreHistorySnapshot])

  const redoCanvas = useCallback((): void => {
    const target = historyFutureRef.current.pop()
    if (!target) return
    historyPastRef.current.push(captureHistorySnapshot())
    historyCoalesceRef.current = null
    restoreHistorySnapshot(target)
    emitHistoryState()
  }, [captureHistorySnapshot, emitHistoryState, restoreHistorySnapshot])

  useEffect(() => {
    const onUndo = (): void => undoCanvas()
    const onRedo = (): void => redoCanvas()
    window.addEventListener('orcspace:canvas-undo', onUndo)
    window.addEventListener('orcspace:canvas-redo', onRedo)
    return () => {
      window.removeEventListener('orcspace:canvas-undo', onUndo)
      window.removeEventListener('orcspace:canvas-redo', onRedo)
    }
  }, [redoCanvas, undoCanvas])

  useEffect(() => {
    const offAdd = window.api.control.onAddWidget(({ id, title, kind, x, y, from, imagePath, imageName }) => {




      const n = cascadeRef.current
      cascadeRef.current += 1
      const col = n % 6
      const row = Math.floor(n / 6)
      const point = kind && typeof x === 'number' && typeof y === 'number'
        ? { x, y }
        : screenToWorld(90 + col * 60, 90 + row * 60)


      const requestedKind = typeof kind === 'string' ? kind : undefined
      if (requestedKind === 'note' || (requestedKind && !(requestedKind in WIDGET_DEFAULTS))) return
      const added = addWidget(point, id, title, (requestedKind as WidgetKind | undefined) ?? 'terminal', { imagePath, imageName })
      // The in-app paths report a full canvas; this one used to drop the
      // request on the floor, so `orc canvas add` at the cap looked like the
      // CLI had simply not run.
      if (!added) {
        window.dispatchEvent(
          new CustomEvent('orcspace:canvas-notice', {
            detail: { message: 'Canvas is full — close a widget before adding another.' }
          })
        )
      }






      if (added && from) {
        connectionsDirtyRef.current = true
        setConnections((prev) => [
          ...prev,
          { id: makeConnectionId(), from, to: id, bornAt: Date.now() }
        ])
      }
    })
    const offRemove = window.api.control.onRemoveWidget(removeWidget)
    const offRename = window.api.control.onRenameWidget(({ id, title }) => {
      // Backend title events are synchronization, not a separate canvas edit.
      // Recording them made Undo restore the temporary "Terminal 1" title
      // instead of undoing the terminal creation.
      widgetsRef.current = widgetsRef.current.map((widget) => widget.id === id ? { ...widget, title } : widget)
      setWidgets((prev) => prev.map((widget) => (widget.id === id ? { ...widget, title } : widget)))
    })
    return () => {
      offAdd()
      offRemove()
      offRename()
    }
  }, [addWidget, removeWidget, screenToWorld])



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
    updateWidgets,
    bringToFront,
    toggleMaximize,
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
    connections,
    suppressWidget
  }
}
