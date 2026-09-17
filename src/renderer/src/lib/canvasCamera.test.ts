import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fitCameraToRect, zoomCameraAt, zoomCameraBy } from './canvasCamera.ts'

describe('canvas camera zoom anchoring', () => {
  test('keeps the anchored screen point stable', () => {
    const camera = { x: 80, y: -20, zoom: 1 }
    const anchor = { x: 400, y: 240 }
    const next = zoomCameraAt(camera, 2, anchor)
    assert.deepEqual(next, { x: -240, y: -280, zoom: 2 })
    assert.equal((anchor.x - camera.x) / camera.zoom, (anchor.x - next.x) / next.zoom)
    assert.equal((anchor.y - camera.y) / camera.zoom, (anchor.y - next.y) / next.zoom)
  })

  test('clamps button and shortcut steps to the supported range', () => {
    const anchor = { x: 0, y: 0 }
    assert.equal(zoomCameraBy({ x: 0, y: 0, zoom: 4 }, 1, anchor).zoom, 4)
    assert.equal(zoomCameraBy({ x: 0, y: 0, zoom: 0.2 }, -1, anchor).zoom, 0.2)
  })
})

describe('fitCameraToRect', () => {
  const VIEW_W = 1600
  const VIEW_H = 900
  const TOP = 40
  const BOTTOM = 88

  test('centers content at 1:1 when it already fits', () => {
    const rect = { x: 0, y: 0, w: 680, h: 420 }
    const next = fitCameraToRect(VIEW_W, VIEW_H, TOP, BOTTOM, rect)
    assert.equal(next.zoom, 1)
    // The rect center lands on the usable-area center.
    assert.equal(rect.x + rect.w / 2 + next.x, VIEW_W / 2)
    const usableCenterY = TOP + (VIEW_H - TOP - BOTTOM) / 2
    assert.equal(rect.y + rect.h / 2 + next.y, usableCenterY)
  })

  test('zooms out to frame oversized content and keeps it centered', () => {
    const rect = { x: -500, y: 200, w: 3200, h: 1800 }
    const next = fitCameraToRect(VIEW_W, VIEW_H, TOP, BOTTOM, rect)
    assert.ok(next.zoom < 1)
    assert.ok(next.zoom >= 0.2)
    const cx = (rect.x + rect.w / 2) * next.zoom + next.x
    const usableCenterY = TOP + (VIEW_H - TOP - BOTTOM) / 2
    const cy = (rect.y + rect.h / 2) * next.zoom + next.y
    assert.ok(Math.abs(cx - VIEW_W / 2) < 1e-9)
    assert.ok(Math.abs(cy - usableCenterY) < 1e-9)
  })

  test('never zooms in past 1:1 for tiny content', () => {
    const next = fitCameraToRect(VIEW_W, VIEW_H, TOP, BOTTOM, { x: 0, y: 0, w: 100, h: 100 })
    assert.equal(next.zoom, 1)
  })

  test('a degenerate rect yields the identity camera', () => {
    const next = fitCameraToRect(VIEW_W, VIEW_H, TOP, BOTTOM, { x: 10, y: 20, w: 0, h: 0 })
    assert.equal(next.zoom, 1)
  })
})
