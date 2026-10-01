import { test, expect } from '@playwright/test'
import { launchOrcSpace, closeOrcSpace, waitForCanvas } from '../helpers/app'

test('the drawing surface allocates only when used and stays bounded on large displays', async () => {
  const ctx = await launchOrcSpace({ viewport: { width: 3000, height: 1800 }, gpu: true })
  try {
    const { page } = ctx
    await waitForCanvas(page)
    const drawing = page.getByTestId('canvas').locator(':scope > canvas')
    await expect(drawing).toHaveCount(0)
    await page.evaluate(async () => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
      const snapshot = await window.api.canvas.load()
      await window.api.canvas.save({
        widgets: snapshot.widgets,
        camera: snapshot.camera,
        connections: snapshot.connections ?? [],
        strokes: [{ id: 'memory-test-stroke', points: [{ x: 10, y: 10 }, { x: 100, y: 100 }], color: '#ffffff' }]
      })
    })
    await expect(drawing).toHaveCount(1)
    const pixels = await drawing.evaluate((canvas: HTMLCanvasElement) => canvas.width * canvas.height)
    expect(pixels).toBeGreaterThan(0)
    expect(pixels).toBeLessThanOrEqual(16_000_000)
  } finally {
    await closeOrcSpace(ctx)
  }
})
