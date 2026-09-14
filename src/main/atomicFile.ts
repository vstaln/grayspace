import * as fs from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'

/**
 * Write a file atomically: create a fresh temp file, fsync it, then rename it
 * over the target. A crash can leave the old content or the new content, never
 * a truncated mix.
 *
 * `mode` is applied to the temp file with fchmod rather than to the write call:
 * `fs.writeFileSync(fd, …, { mode })` silently ignores the mode for a file
 * descriptor, and the umask can strip bits from `open(…, mode)`. Since rename
 * carries the temp file's permissions onto the target, getting this wrong is
 * how a 0600 secret ends up world-readable.
 */
export function writeFileAtomicSync(
  file: string,
  content: string,
  options: { mode?: number; ensureDir?: string | null } = {}
): void {
  const mode = options.mode ?? 0o644
  if (options.ensureDir) fs.mkdirSync(options.ensureDir, { recursive: true })
  const dir = dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  // O_EXCL: never overwrite a racing writer's temp file.
  const temp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  const handle = fs.openSync(temp, 'wx', mode)
  let closed = false
  try {
    try {
      fs.fchmodSync(handle, mode)
    } catch {
      // Filesystems without permission bits (some Windows/network mounts).
    }
    fs.writeFileSync(handle, content, 'utf8')
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    closed = true
    fs.renameSync(temp, file)
  } catch (error) {
    if (!closed) {
      try { fs.closeSync(handle) } catch {  }
    }
    try { fs.rmSync(temp, { force: true }) } catch {  }
    throw error
  }
}

export function writeConfigAtomic(file: string, content: string, ensureDir: string | null = null): void {
  writeFileAtomicSync(file, content, { ensureDir })
}
