import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value))
const smooth = (value: number): number => { const t = clamp(value); return t * t * (3 - 2 * t) }

type Mote = { angle: number; reach: number; speed: number; size: number; tone: number; seed: number }

function makeMote(): Mote {
  return {
    angle: Math.random() * Math.PI * 2,
    reach: .5 + Math.random() * .85,
    speed: .05 + Math.random() * .16,
    size: .5 + Math.random() * 1.5,
    tone: .3 + Math.random() * .7,
    seed: Math.random()
  }
}

/**
 * The curtain the app pulls across itself while an update lands: the canvas
 * palette, a ring that reads the progress and motes drifting out through it,
 * so the installer's own wizard never has to be seen.
 */
export function UpdateCurtain({ percent, label }: {
  percent: number
  /** Screen-reader name for the curtain. */
  label: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The draw loop reads progress every frame; a ref keeps it out of the effect
  // dependencies so a percentage tick never restarts the animation.
  const targetRef = useRef(percent)
  targetRef.current = clamp(percent, 0, 100)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let width = 0
    let height = 0
    const started = performance.now()
    // The shown value chases the real one, so a jump from 12% to 40% still
    // reads as a sweep rather than a snap.
    let shown = targetRef.current
    let motes: Mote[] = []
    // The moment the bar fills, every mote is let go at once — the one big
    // gesture the screen gets to make.
    let burstAt = 0

    const draw = (now: number): void => {
      const t = (now - started) / 1000
      shown += (targetRef.current - shown) * (motion.matches ? 1 : .07)
      const p = clamp(shown / 100)
      const cx = width / 2
      const cy = height / 2
      const unit = Math.min(width, height)
      const intro = smooth(t / 1.2)
      if (!burstAt && shown >= 99.6) burstAt = t
      const burst = burstAt ? clamp((t - burstAt) / 1.6) : 0

      context.fillStyle = '#080808'
      context.fillRect(0, 0, width, height)

      // Motes leave the centre in every direction and fade out at the rim;
      // progress only makes them brighter and a little quicker.
      for (const m of motes) {
        const life = (t * m.speed * (.7 + p * .6) + m.seed) % 1
        const eased = life * life
        const thrown = burst > 0 ? 1 + burst ** 2 * 14 * (.6 + m.reach) : 1
        const distance = unit * (.04 + eased * m.reach * .78) * thrown
        const x = cx + Math.cos(m.angle) * distance
        const y = cy + Math.sin(m.angle) * distance
        const alpha = Math.sin(life * Math.PI) ** 1.4 * m.tone * (.28 + p * .42) * intro
          * (burst > 0 ? smooth(burst * 5) * (1 - smooth((burst - .35) / .65)) : 1)
        if (alpha <= .003) continue
        context.fillStyle = `rgba(255,255,255,${alpha})`
        context.beginPath()
        context.arc(x, y, m.size * (1 + burst * 1.4), 0, Math.PI * 2)
        context.fill()
      }

      // A single shockwave ring rides out with them and dissolves.
      if (burst > 0 && burst < 1) {
        const wave = smooth(burst)
        context.lineWidth = Math.max(1, unit * .004 * (1 - wave))
        context.strokeStyle = `rgba(255,255,255,${(1 - wave) * .35})`
        context.beginPath()
        context.arc(cx, cy, unit * (.05 + wave * .62), 0, Math.PI * 2)
        context.stroke()
      }

      canvas.dataset.phase = burst >= 1 ? 'complete' : burst > 0 ? 'burst' : p > 0 ? 'working' : 'waiting'
      if (!motion.matches) frame = requestAnimationFrame(draw)
    }

    const resize = (): void => {
      cancelAnimationFrame(frame)
      width = window.innerWidth
      height = window.innerHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      motes = Array.from({ length: Math.min(320, Math.round(width * height / 4200)) }, makeMote)
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
  }, [])

  const shownPercent = Math.round(clamp(percent, 0, 100))
  const done = shownPercent >= 100
  return createPortal(
    <div className="fixed inset-0 z-[99000] select-none bg-[#080808] text-white" role="dialog" aria-modal="true" aria-label={label}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
      <div className="update-stage absolute inset-0 flex flex-col items-center justify-center gap-3.5 px-8 text-center">
        {/* The key restarts the fade, so the finished word arrives as its own. */}
        <p key={done ? 'done' : 'busy'} aria-live="polite"
          className={`update-stage text-[11px] font-medium uppercase tracking-[0.08em] ${done ? 'text-white' : 'text-[#B9B9BE]'}`}>
          {done ? 'Updated' : 'Updating'}
        </p>
        <div className={`update-track${done ? ' is-done' : ''}`} aria-hidden>
          <span style={{ width: `${shownPercent}%` }} />
        </div>
        <p className="text-[11px] tabular-nums tracking-[.03em] text-[#A9A9B0]"
          role="progressbar" aria-valuenow={shownPercent} aria-valuemin={0} aria-valuemax={100}>
          {shownPercent}%
        </p>
      </div>
    </div>,
    document.body
  )
}

export default UpdateCurtain
