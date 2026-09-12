// Adapted from React Bits BlurText by David Haz: native animation scheduling.
// https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/TextAnimations/BlurText/BlurText.tsx
// License: ./LICENSE.md
import { useEffect, useRef } from 'react'

export default function BlurText({ text, replay }: { text: string; replay: number }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let animations: Animation[] = []
    const play = (): void => {
      animations.forEach((animation) => animation.cancel())
      animations = []
      if (motion.matches) return
      animations = Array.from(ref.current?.children ?? [], (element, index) => element.animate([
        { filter: 'blur(10px)', opacity: 0, transform: 'translateY(18px)' },
        { filter: 'blur(5px)', opacity: .5, transform: 'translateY(-3px)' },
        { filter: 'blur(0px)', opacity: 1, transform: 'translateY(0)' }
      ], { duration: 1200, delay: 400 + index * 180, easing: 'ease-out', fill: 'backwards' }))
    }
    play()
    motion.addEventListener('change', play)
    return () => {
      animations.forEach((animation) => animation.cancel())
      motion.removeEventListener('change', play)
    }
  }, [text, replay])
  return <span ref={ref} className="startup-blur-text" aria-label={text}>
    {text.split(' ').map((word, index) => <span key={index} aria-hidden="true">{word}{'\u00a0'}</span>)}
  </span>
}
