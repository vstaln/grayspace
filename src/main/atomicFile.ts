import * as fs from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'


export function writeConfigAtomic(file: string, content: string, ensureDir: string | null = null): void {
  if (ensureDir) fs.mkdirSync(ensureDir, { recursive: true })
  const dir = dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(temp, content, 'utf8')
  try { fs.renameSync(temp, file) } catch (error) {
    try { fs.rmSync(temp, { force: true }) } catch {  }
    throw error
  }
}
