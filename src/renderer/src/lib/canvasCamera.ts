import type { Camera, Point } from '../types'

export const MIN_CANVAS_ZOOM = 0.2
export const MAX_CANVAS_ZOOM = 4
export const CANVAS_ZOOM_FACTOR = 1.2

/** Change zoom while keeping the world point below `anchor` under the cursor. */
export function zoomCameraAt(camera: Camera, requestedZoom: number, anchor: Point): Camera {
  const zoom = Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, requestedZoom))
  if (zoom === camera.zoom) return camera
  return {
    zoom,
    x: anchor.x - ((anchor.x - camera.x) / camera.zoom) * zoom,
    y: anchor.y - ((anchor.y - camera.y) / camera.zoom) * zoom
  }
}

export function zoomCameraBy(camera: Camera, direction: 1 | -1, anchor: Point): Camera {
  return zoomCameraAt(camera, camera.zoom * (direction > 0 ? CANVAS_ZOOM_FACTOR : 1 / CANVAS_ZOOM_FACTOR), anchor)
}

/** World-space rectangle to frame, e.g. the bounding box of the widgets. */
export interface FitViewRect {
  x: number
  y: number
  w: number
  h: number
}

/** Breathing room kept between framed content and the viewport edge, in px. */
export const FIT_VIEW_PADDING_PX = 48

/**
 * Camera that frames `rect` inside a `viewW`x`viewH` screen area while keeping
 * the `topReserve` (title bar) and `bottomReserve` (toolbar) bands clear.
 * Only ever zooms out, never past 1:1 — a layout smaller than the window is
 * centered, not blown up.
 */
export function fitCameraToRect(
  viewW: number,
  viewH: number,
  topReserve: number,
  bottomReserve: number,
  rect: FitViewRect
): Camera {
  const usableW = Math.max(1, viewW - FIT_VIEW_PADDING_PX * 2)
  const usableH = Math.max(1, viewH - topReserve - bottomReserve - FIT_VIEW_PADDING_PX * 2)
  const zoom = rect.w <= 0 || rect.h <= 0
    ? 1
    : Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, Math.min(1, usableW / rect.w, usableH / rect.h)))
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  return {
    zoom,
    x: viewW / 2 - cx * zoom,
    y: topReserve + usableH / 2 + FIT_VIEW_PADDING_PX - cy * zoom
  }
}
