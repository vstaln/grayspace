import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// UnoCSS generates the utilities; every design value lives in `design/`.
import 'virtual:uno.css'
import { installStyles } from './design'

installStyles()

// Errors outside React's render tree — IPC callbacks, DOM listeners, and the
// fire-and-forget promise chains across the widgets — never reach an
// ErrorBoundary. Without these handlers they vanish silently (or, for
// rejections, only show up as console noise in dev), so log both centrally.
window.addEventListener('error', (event) => {
  console.error('Unhandled error:', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  // IPC calls against a terminal that was disposed mid-flight (folder
  // switch, widget unmount, agent handoff) reject with a predictable
  // message. Those are expected, not bugs — swallow them.
  if (/disposed|destroyed|no such terminal/i.test(message)) return
  console.error('Unhandled promise rejection:', reason)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
