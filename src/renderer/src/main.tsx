import ReactDOM from 'react-dom/client'
import { useCallback, useEffect, useState } from 'react'
import StartupWordmark from './components/StartupWordmark'
import App from './App'

import 'virtual:uno.css'
import { installStyles } from './ui'

installStyles()

// Temporary design preview; set to false to restore normal startup.
const STARTUP_PREVIEW = false





window.addEventListener('error', (event) => {
  console.error('Unhandled error:', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)



  if (/disposed|destroyed|no such terminal/i.test(message)) return
  console.error('Unhandled promise rejection:', reason)
})

function Startup(): React.JSX.Element | null {
  const [finished, setFinished] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const complete = useCallback(() => setFinished(true), [])
  useEffect(() => {
    if (STARTUP_PREVIEW) return
    const root = document.getElementById('root')
    if (root) root.inert = !dismissed
    if (dismissed) {
      root?.classList.add('is-visible')
      document.getElementById('startup-screen')?.remove()
      return () => { if (root) root.inert = false }
    }
    // The intro animation runs for eight seconds and #root is inert for all
    // of it, so without an escape hatch every launch is eight seconds of an
    // app that looks hung and ignores every click. Any deliberate input ends
    // it immediately; the timer stays as the backstop for a machine where
    // requestAnimationFrame never runs (minimised or occluded at launch), in
    // which case the animation's own completion callback never fires.
    const skip = (event: Event): void => {
      if (event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey || event.altKey)) return
      complete()
    }
    window.addEventListener('pointerdown', skip)
    window.addEventListener('keydown', skip)
    const fallback = setTimeout(complete, 9000)
    return () => {
      clearTimeout(fallback)
      window.removeEventListener('pointerdown', skip)
      window.removeEventListener('keydown', skip)
      if (root) root.inert = false
    }
  }, [dismissed, complete])
  useEffect(() => {
    if (STARTUP_PREVIEW || !finished) return
    const screen = document.getElementById('startup-screen')
    if (!screen) { setDismissed(true); return }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let removal: ReturnType<typeof setTimeout> | undefined
    const reveal = setTimeout(() => {
      screen.classList.add('is-ready')
      screen.setAttribute('aria-hidden', 'true')
      removal = setTimeout(() => setDismissed(true), reducedMotion ? 0 : 950)
    }, reducedMotion ? 0 : 200)
    return () => {
      clearTimeout(reveal)
      clearTimeout(removal)
    }
  }, [finished])
  return dismissed ? null : <StartupWordmark preview={STARTUP_PREVIEW} onComplete={complete} />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<>{!STARTUP_PREVIEW && <App />}<Startup /></>)
