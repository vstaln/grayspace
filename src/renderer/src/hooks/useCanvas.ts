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
import { clearInitialCommand } from '../lib/pendingTerminalCommands'

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

export function invalidateStrokeBounds(strokeId?: string): void {
  if (strokeId === undefined) {
    strokeBoundsCache.clear()
    return
  }
  for (const key of Array.from(strokeBoundsCache.keys())) {
    if (key === strokeId || key.startsWith(`${strokeId}:`)) strokeBoundsCache.delete(key)
  }
}

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
 * removed. The two browser entries were missing, so closing a browser widget
 * left its address (and, for dropped media, a JSON blob) behind permanently —
 * one pair per browser widget ever opened, for the life of the install.
 *
 * That matters beyond the wasted space: localStorage has a hard quota, and
 * every write in this app is wrapped in `try {} catch {}`. Once the quota is
 * reached the throw is swallowed and *all* widget persistence silently stops
 * working, with nothing on screen to say why. Anything that starts writing a
 * per-widget key belongs in this list.
 */
/**
 * Per-widget keys that only ever belong to a canvas widget, so "no widget with
 * this id" is proof the entry is garbage and it is safe to sweep on hydration.
 */
const PRUNABLE_WIDGET_PREFIXES = [
  'orcspace-links:',
  'orcspace-music-playlists:',
  'orcspace-music-volume:',
  'orcspace-music-muted:',
  'orcspace-browser-url:',
  'orcspace-browser-media:'
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
 * the browser prefixes were listed there still carry an entry for every
 * browser widget they ever closed, and nothing else would ever collect them.
 * Runs once per hydration against the freshly loaded widget set, which is the
 * only point where "not on the canvas" is reliably known.
 */
function pruneOrphanWidgetStorage(liveWidgetIds: Set<string>): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (!key) continue
      const prefix = PRUNABLE_WIDGET_PREFIXES.find((candidate) => key.startsWith(candidate))
      if (!prefix) continue
      if (!liveWidgetIds.has(key.slice(prefix.length))) localStorage.removeItem(key)
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


const TERMINAL_TITLE = /^Terminal (\d+)$/









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





export function useCanvas() {
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





  const cascadeRef = useRef(0)

  const nextZ = useCallback(() => ++zRef.current, [])






  const hydratedRef = useRef(false)
  const skipNextSaveRef = useRef(false)
  const hydrationRunRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceDirRef = useRef<string | null>(null)
  const workspaceSyncSeqRef = useRef(0)



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
    void window.api.canvas.load()
      .then((snapshot) => {
        if (run !== hydrationRunRef.current) return
        if (canvasChangeSeqRef.current === changesAtStart) {
          setWidgets(snapshot.widgets)
          setCamera(snapshot.camera)
          setStrokes(snapshot.strokes)
          setConnections(snapshot.connections ?? [])
          // Only inside this branch: when local changes have already raced
          // ahead of the load, the snapshot is stale and its widget list
          // would read a just-created widget as an orphan and delete the
          // storage it is about to use.
          pruneOrphanWidgetStorage(new Set(snapshot.widgets.map((w) => w.id)))
        }

        const maxZ = snapshot.widgets.reduce((max, w) => Math.max(max, w.z), 0)
        zRef.current = Math.max(1, maxZ)
        cascadeRef.current = 0


        hydratedRef.current = true
      })
      .catch(() => {




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
  }, [hydrate])

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

  const screenToWorld = useCallback((x: number, y: number, cam: Camera = cameraRef.current): Point => {
    return { x: (x - cam.x) / cam.zoom, y: (y - cam.y) / cam.zoom }
  }, [])

  const addWidget = useCallback(
    (point: Point, id: string = makeLocalId(), title?: string, kind: WidgetKind = 'terminal'): boolean => {
      const defaults = WIDGET_DEFAULTS[kind]











      if (
        widgetsRef.current.length + pendingCreatesRef.current.size >= MAX_WIDGETS ||
        widgetsRef.current.some((widget) => widget.id === id) ||
        pendingCreatesRef.current.has(id)
      ) return false


      pendingCreatesRef.current.add(id)



      const z = nextZ()
      const current = widgetsRef.current
      if (current.length >= MAX_WIDGETS || current.some((widget) => widget.id === id)) {
        pendingCreatesRef.current.delete(id)
        return false
      }
      widgetsDirtyRef.current = true
      dirtyWidgetIdsRef.current.add(id)
      const widgetTitle = title || (kind === 'terminal' ? `Terminal ${nextTerminalNumber(current)}` : defaults.title)
      setWidgets((prev) => {
        if (prev.some((widget) => widget.id === id)) return prev
        return [
          ...prev,
          {
            id,




            title: widgetTitle,
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
      return true
    },
    [nextZ]
  )


  const connectWidgets = useCallback((from: string, to: string): void => {
    if (!from || !to || from === to) return
    if (!widgetsRef.current.some((widget) => widget.id === from) || !widgetsRef.current.some((widget) => widget.id === to)) return
    connectionsDirtyRef.current = true
    setConnections((prev) => {
      if (prev.some((connection) => connection.from === from && connection.to === to)) return prev
      return [...prev, { id: makeConnectionId(), from, to, bornAt: Date.now() }]
    })
  }, [])

  const disconnectWidgets = useCallback((from: string, to?: string): void => {
    if (!from) return
    connectionsDirtyRef.current = true
    setConnections((prev) => prev.filter((connection) => connection.from !== from || (to && connection.to !== to)))
  }, [])

  const removeWidget = useCallback((id: string): void => {




    pendingDeletesRef.current.add(id)
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
    setWidgets((prev) => prev.filter((w) => w.id !== id))


    connectionsDirtyRef.current = true
    setConnections((prev) => prev.filter((c) => c.from !== id && c.to !== id))
  }, [])




  const widgetPatchRef = useRef<Map<string, Partial<Widget>>>(new Map())
  const widgetRafRef = useRef<number | null>(null)

  const updateWidget = useCallback((id: string, change: Partial<Widget>): void => {
    widgetsDirtyRef.current = true
    dirtyWidgetIdsRef.current.add(id)
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




  const strokeBatchRef = useRef<Map<string, Point[]>>(new Map())
  const strokeRafRef = useRef<number | null>(null)

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




  const discardStroke = useCallback((id: string): void => {
    strokeBatchRef.current.delete(id)
    strokesDirtyRef.current = true
    setStrokes((prev) => prev.filter((s) => s.id !== id))
  }, [])














  const eraseAt = useCallback((point: Point, radius = 14): void => {
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
  }, [])

  useEffect(() => {
    const offAdd = window.api.control.onAddWidget(({ id, title, kind, x, y, from }) => {




      const n = cascadeRef.current
      cascadeRef.current += 1
      const col = n % 6
      const row = Math.floor(n / 6)
      const point = kind && typeof x === 'number' && typeof y === 'number'
        ? { x, y }
        : screenToWorld(90 + col * 60, 90 + row * 60)


      const requestedKind = typeof kind === 'string' ? kind : undefined
      if (requestedKind === 'note' || (requestedKind && !(requestedKind in WIDGET_DEFAULTS))) return
      const added = addWidget(point, id, title, (requestedKind as WidgetKind | undefined) ?? 'terminal')
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
    connectWidgets,
    disconnectWidgets,
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
