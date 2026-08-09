import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Tailwind's utility generation only — every design value lives in `design/`.
import './tailwind.css'
import { installStyles } from './design'

installStyles()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
