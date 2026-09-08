import ReactDOM from 'react-dom/client'
import App from './App'

import 'virtual:uno.css'
import { installStyles } from './design'

installStyles()





window.addEventListener('error', (event) => {
  console.error('Unhandled error:', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)



  if (/disposed|destroyed|no such terminal/i.test(message)) return
  console.error('Unhandled promise rejection:', reason)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
