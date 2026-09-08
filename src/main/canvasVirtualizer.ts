import type { CanvasCamera, CanvasStroke, CanvasWidget } from './canvasState.ts'

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

  padding?: number

  lodThresholds?: {
    full: number
    compact: number

  }
}




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




export function bboxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
}










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




export class CanvasVirtualizer {
  private readonly strokeBBoxes = new Map<string, BoundingBox>()
  private readonly options: Required<VirtualizerOptions>

  constructor(options: VirtualizerOptions = {}) {
    this.options = {
      padding: options.padding ?? 150,
      lodThresholds: options.lodThresholds ?? { full: 0.5, compact: 0.2 }
    }
  }




  getLOD(zoom: number): LODLevel {
    if (zoom >= this.options.lodThresholds.full) return 'full'
    if (zoom >= this.options.lodThresholds.compact) return 'compact'
    return 'placeholder'
  }




  cull(
    widgets: readonly CanvasWidget[],
    strokes: readonly CanvasStroke[],
    camera: CanvasCamera,
    viewport: Viewport
  ): VirtualizationResult {



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
