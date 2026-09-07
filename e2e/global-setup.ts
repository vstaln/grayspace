import fs from 'node:fs'
import path from 'node:path'

/**
 * Fast, human-readable failure when the built Electron entry is missing. The
 * default `_electron.launch` error is a wall of driver noise; the actual cause
 * here is almost always "forgot to build first".
 */
export default function globalSetup(): void {
  // Playwright invokes the setup from the project root.  Using cwd keeps this
  // file typecheckable under the e2e CommonJS tsconfig as well as runnable
  // from the package's ESM runtime.
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
