// Adapted from React Bits Particles by David Haz, projected with Canvas 2D.
// https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Backgrounds/Particles/Particles.tsx
// License: ./LICENSE.md
export function cloudPoint(): { x: number; y: number; z: number; random: number[] } {
  let x: number, y: number, z: number, length: number
  do {
    x = Math.random() * 2 - 1
    y = Math.random() * 2 - 1
    z = Math.random() * 2 - 1
    length = x * x + y * y + z * z
  } while (length > 1 || length === 0)
  const radius = Math.cbrt(Math.random())
  return { x: x * radius, y: y * radius, z: z * radius,
    random: [Math.random(), Math.random(), Math.random(), Math.random()] }
}

export function moveCloudPoint(point: ReturnType<typeof cloudPoint>, time: number): { x: number; y: number; z: number } {
  const r = point.random
  return {
    x: point.x + Math.sin(time * r[2] + 6.28 * r[3]) * (.015 + .06 * r[0]),
    y: point.y + Math.sin(time * r[1] + 6.28 * r[0]) * (.015 + .06 * r[3]),
    z: point.z + Math.sin(time * r[3] + 6.28 * r[1]) * (.015 + .06 * r[2])
  }
}
