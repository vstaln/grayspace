import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, waitForTerminalShell } from '../helpers/app'

/**
 * xterm turns a pointer position into a cell by dividing its offset inside
 * `getBoundingClientRect()` by the cell size. The rect is measured on screen and
 * carries the canvas camera's zoom; the cell size is laid out and does not. At
 * zoom 1.25 a 15px row is 18.75px on screen while xterm still divides by 15, so
 * everything the pointer does lands a row or more away from it — a selection, or
 * a click inside a TUI that tracks the mouse.
 *
 * The widget corrects the positions on their way in, so what matters here is
 * what the terminal is handed: at any zoom it must be the offset it would have
 * seen with the camera at 1:1.
 */
async function pointerProbe(page: import('@playwright/test').Page, offsetX: number, offsetY: number) {
  return page.evaluate(
    ({ offsetX, offsetY }) => {
      const screen = document.querySelector('.xterm-screen') as HTMLElement
      const rect = screen.getBoundingClientRect()
      const scale = rect.width / screen.offsetWidth
      const received: { x: number; y: number }[] = []
      const listener = (event: MouseEvent): void => {
        received.push({ x: event.clientX - rect.left, y: event.clientY - rect.top })
      }
      screen.addEventListener('mousedown', listener)
      screen.dispatchEvent(
        new MouseEvent('mousedown', {
          clientX: rect.left + offsetX,
          clientY: rect.top + offsetY,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1
        })
      )
      screen.removeEventListener('mousedown', listener)
      return { scale, received }
    },
    { offsetX, offsetY }
  )
}

test('the terminal is handed pointer positions with the canvas zoom taken out', async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await waitForCanvas(page)
    await page.getByTestId('canvas').click({ button: 'right', position: { x: 60, y: 90 } })
    await page.getByTestId('cm-terminal').click()
    await waitForTerminalShell(ctx, page)

    const setZoom = async (zoom: number): Promise<void> => {
      await page.evaluate(async (value) => {
        const snapshot = await window.api.canvas.load()
        await window.api.canvas.save({
          widgets: snapshot.widgets,
          camera: { ...snapshot.camera, zoom: value },
          strokes: snapshot.strokes,
          connections: snapshot.connections ?? []
        })
      }, zoom)
      await expect
        .poll(() => page.evaluate(() => {
          const screen = document.querySelector('.xterm-screen') as HTMLElement
          return Math.round((screen.getBoundingClientRect().width / screen.offsetWidth) * 100) / 100
        }))
        .toBe(zoom)
    }

    // 1:1 — the pointer is passed through untouched.
    await setZoom(1)
    const plain = await pointerProbe(page, 200, 150)
    expect(plain.received).toHaveLength(1)
    expect(plain.received[0].x).toBeCloseTo(200, 1)
    expect(plain.received[0].y).toBeCloseTo(150, 1)

    for (const zoom of [1.25, 0.8]) {
      await setZoom(zoom)
      const scaled = await pointerProbe(page, 200 * zoom, 150 * zoom)
      // Exactly one event reaches the terminal: the corrected one, not both.
      expect(scaled.received, `zoom ${zoom} must deliver a single corrected event`).toHaveLength(1)
      // Mouse events carry integer coordinates, so the round trip through the
      // scale can land a pixel out. A cell is fifteen pixels tall; what this
      // guards against is the tens of pixels the missing scale used to cost.
      expect(Math.abs(scaled.received[0].x - 200), `zoom ${zoom} column`).toBeLessThanOrEqual(2)
      expect(Math.abs(scaled.received[0].y - 150), `zoom ${zoom} row`).toBeLessThanOrEqual(2)
    }
  } finally {
    await closeOrcSpace(ctx)
  }
})
