import { MIN_CANVAS_ZOOM } from './canvasCamera.ts'

/**
 * Making the canvas shrink with the window without touching the layout.
 *
 * The canvas is world-locked: a widget's x/y/w/h are world coordinates, and
 * what the window size changes is only how much of that world fits on screen.
 * So a small window used to mean *less canvas*, not *smaller widgets* — the
 * only way to see everything again was the explicit Fit action.
 *
 * Adapting through the camera rather than the layout is what keeps this
 * reversible. Nothing on disk changes: shrink the window and the zoom follows
 * it down, grow it back and the zoom returns to exactly the value it had,
 * because the displayed zoom is always recomputed from a stored baseline
 * rather than multiplied into itself. Rewriting each widget's geometry instead
 * would have been a one-way trip — the original proportions are not
 * recoverable from the scaled ones once they have been rounded and clamped.
 *
 * The baseline is "the zoom the user chose, and the window size they chose it
 * at". Every manual zoom replaces it, so the user's last explicit choice is
 * always what 100% means, and adaptation is measured from there.
 */

export interface ViewportSize {
  w: number
  h: number
}

/** The zoom the user chose, and the viewport it was chosen at. */
export interface ZoomBaseline {
  zoom: number
  viewport: ViewportSize
}

/**
 * Below this the adaptation stops; the canvas pans instead.
 *
 * Shrinking without a floor turns a narrow window into an unreadable one, and
 * an unreadable terminal is worse than a clipped one. It is expressed against
 * the baseline rather than as an absolute zoom so that a user who has already
 * zoomed out to 40% still gets some adaptation rather than none.
 */
export const MIN_RESPONSIVE_SCALE = 0.45

/** Zoom differences below this are not worth a re-render. */
export const ZOOM_EPSILON = 0.0005

export function isUsableViewport(viewport: ViewportSize): boolean {
  return (
    Number.isFinite(viewport.w) && Number.isFinite(viewport.h) && viewport.w > 0 && viewport.h > 0
  )
}

/**
 * How much of the baseline viewport the current one still offers.
 *
 * The smaller of the two axes decides, because that is the one that runs out
 * of room first — a window made narrow but left tall has to scale by width or
 * its widgets are still cut off.
 *
 * Capped at 1: a window *larger* than the baseline does not magnify anything.
 * Growing past the size the zoom was chosen at should reveal more canvas,
 * which is what the world-locked behaviour already did well, and blowing
 * widgets up past the size the user picked would be a surprise in the
 * opposite direction.
 */
export function viewportScale(baseline: ZoomBaseline, viewport: ViewportSize): number {
  if (!isUsableViewport(viewport) || !isUsableViewport(baseline.viewport)) return 1
  const scale = Math.min(viewport.w / baseline.viewport.w, viewport.h / baseline.viewport.h)
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(1, Math.max(MIN_RESPONSIVE_SCALE, scale))
}

/**
 * The zoom this viewport should display at, derived from the baseline.
 *
 * Always computed from the baseline, never from the zoom currently on screen.
 * Compounding would make the result depend on the path taken — a window
 * nudged smaller twenty times would end up somewhere different from one
 * dragged to the same size in a single motion, and neither would come back.
 */
export function responsiveZoom(baseline: ZoomBaseline, viewport: ViewportSize): number {
  const target = baseline.zoom * viewportScale(baseline, viewport)
  return Math.max(MIN_CANVAS_ZOOM, target)
}

/** Whether a recomputed zoom differs enough from the live one to apply. */
export function zoomChanged(current: number, next: number): boolean {
  return Math.abs(current - next) > ZOOM_EPSILON
}

/** A baseline plus the zoom the adaptation last wrote from it. */
export interface ZoomAdaptationState extends ZoomBaseline {
  /** What this adaptation last applied; anything else came from the user. */
  applied: number
}

export type ZoomAdaptation =
  /** Nothing to do — already at the right zoom, or nothing measured yet. */
  | { kind: 'idle' }
  /** Someone set the zoom deliberately; that choice is the new baseline. */
  | { kind: 'rebaseline'; state: ZoomAdaptationState }
  /** The viewport moved; the camera should go to this zoom. */
  | { kind: 'apply'; zoom: number; state: ZoomAdaptationState }

/**
 * One step of the adaptation, as a function of what is on screen.
 *
 * This lives here rather than inside the effect that drives it because it is
 * a feedback loop: applying a zoom changes the camera, which re-runs the
 * decision, and the thing that keeps that from oscillating is `applied` —
 * the loop recognising its own last write. That is worth being able to test
 * without a canvas, a window or a React tree.
 *
 * Telling a deliberate zoom from this loop's own needs no cooperation from
 * whoever set it: a wheel, a button, Fit and a hydrated workspace all land
 * here as "the zoom is not what I last applied", so a new caller cannot
 * forget to announce itself.
 */
/**
 * Where the baseline is kept between runs.
 *
 * It has to outlive the process, because what gets written to the canvas
 * snapshot is the *displayed* zoom — the adapted one. Without the baseline
 * beside it, a session that ended in a small window would come back with the
 * shrunken zoom as its new definition of 100%, and growing the window would
 * never undo it: the shrink would have quietly become permanent, which is the
 * one thing this whole approach exists to avoid.
 *
 * The `orcspace:` prefix is what makes localStorage durable here — keys with
 * it are mirrored to the main process and restored on launch.
 */
export const ZOOM_BASELINE_STORAGE_KEY = 'orcspace:canvas-zoom-baseline'

/**
 * How long the baseline waits after the last change before being stored.
 *
 * Every durable key written also crosses to the main process, so a window
 * being dragged must not persist once per resize event. Only where the drag
 * comes to rest is worth keeping.
 */
export const ZOOM_BASELINE_SAVE_DELAY_MS = 500

/** Serialized form of a baseline, for the storage key above. */
export function serializeZoomBaseline(state: ZoomAdaptationState): string {
  return JSON.stringify({
    zoom: state.zoom,
    w: state.viewport.w,
    h: state.viewport.h,
    applied: state.applied
  })
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * A stored baseline, or null when there is nothing usable.
 *
 * Anything unparseable is discarded rather than repaired: a baseline is
 * re-established from the live camera on the next frame at no cost, so there
 * is nothing to gain by trusting a damaged one.
 */
export function parseZoomBaseline(raw: string | null | undefined): ZoomAdaptationState | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { zoom, w, h, applied } = parsed as Record<string, unknown>
    if (!finitePositive(zoom) || !finitePositive(w) || !finitePositive(h) || !finitePositive(applied)) {
      return null
    }
    return { zoom, viewport: { w, h }, applied }
  } catch {
    return null
  }
}

export function adaptCanvasZoom(
  previous: ZoomAdaptationState | null,
  cameraZoom: number,
  viewport: ViewportSize
): ZoomAdaptation {
  if (!isUsableViewport(viewport)) return { kind: 'idle' }
  // A camera restored from a damaged store can arrive as 0 or NaN. Adopting
  // that as the baseline would multiply every later viewport against it and
  // wedge the canvas at the minimum zoom for the rest of the session, so it
  // is read as the neutral 1 instead — the same value a fresh canvas starts
  // at, which the clamp below would have produced anyway.
  const zoom = Number.isFinite(cameraZoom) && cameraZoom > 0 ? cameraZoom : 1
  if (previous === null || zoomChanged(previous.applied, zoom)) {
    return {
      kind: 'rebaseline',
      state: { zoom, viewport, applied: zoom }
    }
  }
  const next = responsiveZoom(previous, viewport)
  if (!zoomChanged(zoom, next)) return { kind: 'idle' }
  return { kind: 'apply', zoom: next, state: { ...previous, applied: next } }
}
