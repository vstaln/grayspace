import fs from 'node:fs'
import path from 'node:path'






export default function globalSetup(): void {



  const root = path.resolve(process.cwd())
  const mainJs = path.join(root, 'out', 'main', 'index.js')
  const renderer = path.join(root, 'out', 'renderer', 'index.html')
  if (!fs.existsSync(mainJs)) {
    throw new Error(
      `Electron main entry not found at ${mainJs} — run "npm run build" before "npm run test:e2e".`
    )
  }
  if (!fs.existsSync(renderer)) {
    throw new Error(`Built renderer not found at ${renderer} — run "npm run build" first.`)
  }
}
