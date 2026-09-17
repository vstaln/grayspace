/**
 * Undo the canvas camera's scale for xterm's pointer arithmetic.
 *
 * xterm turns a pointer position into a cell by taking the offset inside its
 * screen element's `getBoundingClientRect()` and dividing it by the cell size.
 * The rect is measured on screen, so it carries every CSS transform above it —
 * the canvas camera's zoom included. The cell size does not: it comes from
 * laying out a measuring element, which a transform never touches. At zoom 1.25
 * a 15px row is 18.75px on screen while xterm still divides by 15, so a click
 * eight rows down is read as ten rows down and the selection lands nowhere near
 * the pointer.
 *
 * Nothing in xterm's API takes a scale, so the correction happens to the
 * pointer positions on their way in: the offset inside the rect is divided by
 * the same factor xterm's own arithmetic is missing.
 */

/** Below this the scale is 1 for all practical purposes and nothing is rewritten. */
const SCALE_EPSILON = 0.001

/**
 * How much bigger the element is on screen than in layout — the camera's zoom,
 * read off the element rather than passed down, so the terminal needs to know
 * nothing about the canvas.
 */
export function pointerScale(screenWidth: number, layoutWidth: number): number {
  if (!Number.isFinite(screenWidth) || !Number.isFinite(layoutWidth) || layoutWidth <= 0) return 1
  const scale = screenWidth / layoutWidth
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

export function isPointerScaled(scale: number): boolean {
  return Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > SCALE_EPSILON
}

/**
 * The position xterm would have to see for its own (unscaled) cell arithmetic
 * to land on the cell the pointer is actually over.
 */
export function unscalePointer(
  rect: { left: number; top: number },
  scale: number,
  clientX: number,
  clientY: number
): { clientX: number; clientY: number } {
  if (!isPointerScaled(scale)) return { clientX, clientY }
  return {
    clientX: rect.left + (clientX - rect.left) / scale,
    clientY: rect.top + (clientY - rect.top) / scale
  }
}
