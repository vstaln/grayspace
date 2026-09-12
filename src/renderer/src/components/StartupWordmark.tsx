import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cloudPoint, moveCloudPoint } from './react-bits/particleCloud'
import reactBitsLicense from './react-bits/LICENSE.md?raw'

const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const smooth = (value: number): number => { const t = clamp(value); return t * t * (3 - 2 * t) }

export default function StartupWordmark({ preview = false, onComplete }: { preview?: boolean; onComplete?: () => void }): React.JSX.Element | null {
  const host = document.getElementById('startup-wordmark')
  const caption = document.getElementById('startup-caption')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const readyRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let width = 0
    let height = 0
    let started = 0
    let points: { cloud: ReturnType<typeof cloudPoint>; delay: number; radius: number }[] = []

    const draw = (now: number): void => {
      const t = motion.matches ? (preview ? 4.5 : 9.2) : (now - started) / 1000
      context.clearRect(0, 0, width, height)
      const cx = width / 2
      const cy = height * .47
      const fade = 1 - smooth((t - 6) / 1)

      if (fade > 0) {
        context.fillStyle = '#ffffff'
        for (const p of points) {
          const travel = clamp((t - 1 - p.delay) / (6.5 - p.delay * .4))
          const pull = smooth(travel) ** 1.5
          const cloud = moveCloudPoint(p.cloud, t * .3)
          const sx = p.cloud.random[0] * width + cloud.x * 12
          const sy = p.cloud.random[1] * height + cloud.y * 12
          const angle = Math.atan2(sy - cy, sx - cx) + pull * (2.5 + p.cloud.random[3] * 2)
          const burst = clamp((t - 5.9 - p.delay * .08) / .55)
          const distance = burst > 0
            ? (8 + p.cloud.random[2] * 55) * (1 + burst ** 2 * 125)
            : Math.hypot(sx - cx, sy - cy) * (1 - pull)
          const x = cx + Math.cos(angle) * distance
          const y = cy + Math.sin(angle) * distance
          context.globalAlpha = smooth(t / 1.5) * (burst > 0 ? smooth(burst * 7) : 1 - smooth((travel - .93) / .07)) * (.25 + p.cloud.random[2] * .65) * fade
          context.beginPath()
          context.arc(x, y, p.radius * (1 + burst * 6), 0, Math.PI * 2)
          context.fill()
        }
      }

      context.globalAlpha = 1
      // `ready` here is the value captured when the effect ran, so it never
      // flips to true inside this closure: without the ref this called
      // setReady on every frame of the last second of the intro.
      if (t >= 7 && !readyRef.current) {
        readyRef.current = true
        setReady(true)
      }
      canvas.dataset.phase = motion.matches ? 'still' : t >= 8 ? 'complete' : t >= 7 ? 'fading' : t >= 5.9 ? 'burst' : t >= 2.8 ? 'gravity' : 'forming'
      if (!motion.matches && t < 8) frame = requestAnimationFrame(draw)
      else if (!preview) onComplete?.()
    }

    const resize = (): void => {
      cancelAnimationFrame(frame)
      width = window.innerWidth
      height = window.innerHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      points = Array.from({ length: Math.min(2400, Math.round(width * height / 500)) }, () => ({ cloud: cloudPoint(), delay: Math.random() * 2, radius: .3 + Math.random() * .35 }))
      if (!started) started = performance.now()
      draw(performance.now())
    }
    resize()
    window.addEventListener('resize', resize)
    motion.addEventListener('change', resize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      motion.removeEventListener('change', resize)
    }
  }, [preview, onComplete])

  return host ? <>{createPortal(<div className="startup-particle-layer"><canvas ref={canvasRef} aria-hidden="true" /></div>, host)}
    {caption && createPortal(<div className={`startup-track${ready ? ' is-ready' : ''}`} aria-label="Loading"><span /></div>, caption)}
    {caption && createPortal(<div className={`startup-loading-label${ready ? ' is-ready' : ''}`}>{ready ? 'Ready.' : 'Preparing your workspace…'}</div>, caption)}
    <span hidden data-react-bits-license>{reactBitsLicense}</span>
  </> : null
}
