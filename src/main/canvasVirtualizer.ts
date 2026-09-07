import type { CanvasCamera, CanvasPoint, CanvasStroke, CanvasWidget } from './canvasState.ts'

export type LODLevel = 'full' | 'compact' | 'placeholder'

export interface Viewport {
  width: number
  height: number
}

export interface BoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface VirtualizedWidget {
  widget: CanvasWidget
  lod: LODLevel
  screenX: number
  screenY: number
  screenW: number
  screenH: number
}

export interface VirtualizationResult {
  visibleWidgets: VirtualizedWidget[]
  visibleWidgetCount: number
  culledWidgetCount: number
  visibleStrokes: CanvasStroke[]
  visibleStrokeCount: number
  culledStrokeCount: number
  worldViewport: BoundingBox
}

export interface VirtualizerOptions {
  /** Screen padding around viewport in world coordinates to prevent pop-in during pan. */
  padding?: number
  /** Zoom thresholds for Level of Detail. */
  lodThresholds?: {
    full: number     // default >= 0.5: full interactive React widget
    compact: number  // default >= 0.2: compact simplified card
                     // < 0.2: placeholder rect
  }
}

/**
 * Computes Axis-Aligned Bounding Box for a stroke.
 */
export function computeStrokeBBox(stroke: CanvasStroke): BoundingBox {
  if (!stroke.points || stroke.points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const pt of stroke.points) {
    if (pt.x < minX) minX = pt.x
    if (pt.y < minY) minY = pt.y
    if (pt.x > maxX) maxX = pt.x
    if (pt.y > maxY) maxY = pt.y
  }

  return { minX, minY, maxX, maxY }
}

/**
 * Checks if two bounding boxes intersect.
 */
export function bboxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
}

/**
 * Converts screen viewport into world coordinate bounding box.
 * Note: this helper assumes camera.x/y is the world center (main-process
 * convention). The renderer stores camera as translate offset — see
 * App.tsx worldViewport memo. This file is a main-process reuse/benchmark
 * helper, not wired into the renderer culling path (which is intentional:
 * terminal widgets need PTY reconnect, browser widgets lose state on unmount).
 * Keep the formula here documented, not silently diverged.
 */
export function viewportToWorldBox(
  camera: CanvasCamera,
  viewport: Viewport,
  padding = 100
): BoundingBox {
  const halfW = (viewport.width / 2) / camera.zoom + padding
  const halfH = (viewport.height / 2) / camera.zoom + padding

  return {
    minX: camera.x - halfW,
    minY: camera.y - halfH,
    maxX: camera.x + halfW,
    maxY: camera.y + halfH
  }
}

/**
 * Renderer-compatible viewport box: camera is translate offset (App.tsx).
 * Use this when comparing with the renderer's culling logic.
 */
export function viewportToWorldBoxForRenderer(
  camera: CanvasCamera,
  viewport: Viewport,
  padding = 100
): BoundingBox {
  const zoom = camera.zoom || 1
  const pad = padding / zoom
  const minX = (-viewport.width - camera.x) / zoom - pad
  const minY = (-viewport.height - camera.y) / zoom - pad
  const maxX = (2 * viewport.width - camera.x) / zoom + pad
  const maxY = (2 * viewport.height - camera.y) / zoom + pad
  return { minX, minY, maxX, maxY }
}

/**
 * High-performance spatial indexing and viewport culling engine for 10,000+ canvas widgets.
 */
export class CanvasVirtualizer {
  private readonly strokeBBoxes = new Map<string, BoundingBox>()
  private readonly options: Required<VirtualizerOptions>

  constructor(options: VirtualizerOptions = {}) {
    this.options = {
      padding: options.padding ?? 150,
      lodThresholds: options.lodThresholds ?? { full: 0.5, compact: 0.2 }
    }
  }

  /**
   * Evaluates Level of Detail based on camera zoom.
   */
  getLOD(zoom: number): LODLevel {
    if (zoom >= this.options.lodThresholds.full) return 'full'
    if (zoom >= this.options.lodThresholds.compact) return 'compact'
    return 'placeholder'
  }

  /**
   * Culls widgets and strokes against visible camera viewport with LOD computation.
   */
  cull(
    widgets: readonly CanvasWidget[],
    strokes: readonly CanvasStroke[],
    camera: CanvasCamera,
    viewport: Viewport
  ): VirtualizationResult {
    // NOTE: main uses center-convention (viewportToWorldBox), renderer uses translate-convention
    // (viewportToWorldBoxForRenderer). This cull is for main/benchmark use only; do not call
    // it to drive renderer visibility or culling will be wrong.
    const worldBox = viewportToWorldBox(camera, viewport, this.options.padding)
    const lod = this.getLOD(camera.zoom)

    const visibleWidgets: VirtualizedWidget[] = []
    let culledWidgetCount = 0

    for (const w of widgets) {
      const widgetBox: BoundingBox = {
        minX: w.x,
        minY: w.y,
        maxX: w.x + w.w,
        maxY: w.y + w.h
      }

      if (bboxesIntersect(widgetBox, worldBox)) {
        const screenX = (w.x - camera.x) * camera.zoom + viewport.width / 2
        const screenY = (w.y - camera.y) * camera.zoom + viewport.height / 2
        const screenW = w.w * camera.zoom
        const screenH = w.h * camera.zoom

        visibleWidgets.push({
          widget: w,
          lod,
          screenX,
          screenY,
          screenW,
          screenH
        })
      } else {
        culledWidgetCount += 1
      }
    }

    const visibleStrokes: CanvasStroke[] = []
    let culledStrokeCount = 0

    for (const s of strokes) {
      let bbox = this.strokeBBoxes.get(s.id)
      if (!bbox) {
        bbox = computeStrokeBBox(s)
        this.strokeBBoxes.set(s.id, bbox)
      }

      if (bboxesIntersect(bbox, worldBox)) {
        visibleStrokes.push(s)
      } else {
        culledStrokeCount += 1
      }
    }

    // Prune deleted stroke bboxes if the cache grew larger than the active set
    if (this.strokeBBoxes.size > strokes.length + 50) {
      const activeIds = new Set(strokes.map((s) => s.id))
      for (const id of this.strokeBBoxes.keys()) {
        if (!activeIds.has(id)) {
          this.strokeBBoxes.delete(id)
        }
      }
    }

    return {
      visibleWidgets,
      visibleWidgetCount: visibleWidgets.length,
      culledWidgetCount,
      visibleStrokes,
      visibleStrokeCount: visibleStrokes.length,
      culledStrokeCount,
      worldViewport: worldBox
    }
  }

  clearCache(): void {
    this.strokeBBoxes.clear()
  }
}
