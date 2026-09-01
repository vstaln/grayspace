import * as electron from 'electron'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
const ansiModuleDir = dirname(fileURLToPath(import.meta.url))

type NativeStorageCore = {
  /** Rust ANSI stripper (native/storage-core/src/lib.rs). */
  stripAnsiText?(text: string): string
}

const nativeStorageCore = ((): NativeStorageCore | null => {
  try {
    const require = createRequire(import.meta.url)
    // Same load pattern as storage.ts: packaged builds ship native/* under
    // resourcesPath, dev builds resolve relative to source.
    const nativeDir = electronApp?.isPackaged
      ? join(process.resourcesPath, 'native', 'storage-core')
      : join(ansiModuleDir, '../../native/storage-core')
    return require(nativeDir) as NativeStorageCore
  } catch {
    // An old prebuilt binary without stripAnsiText, or no Rust build at all —
    // the JS twin below keeps the app identical, just slower.
    return null
  }
})()

/**
 * Removes ANSI escape sequences, keeping only the visible text. Covers CSI
 * (`ESC [ … final-byte`), OSC (`ESC ] … BEL|ST`), the charset selectors
 * (`ESC ( X`) and DCS/SOS/PM/APC (`ESC P/X/^/_ … ST`), plus the C1 one-byte
 * spellings — byte-for-byte the same set as `strip_ansi` in
 * native/storage-core, so the fallback and the Rust path agree exactly.
 *
 * Runs of plain text are collected as slices, not built one character at a
 * time: the chat stream cleaner calls this on every chunk of every reply, and
 * an `out += ch` loop would mean thousands of string concatenations per
 * chunk on the main thread.
 */
function stripAnsiJs(text: string): string {
  const parts: string[] = []
  let plainFrom = 0
  let i = 0
  const n = text.length
  const isFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e
  const cut = (upTo: number, resumeAt: number): void => {
    if (upTo > plainFrom) parts.push(text.slice(plainFrom, upTo))
    plainFrom = resumeAt
  }
  while (i < n) {
    const ch = text[i]
    if (ch === '\x1b' && i + 1 < n) {
      const next = text[i + 1]
      if (next === '[') {
        const start = i
        i += 2
        while (i < n && !isFinal(text.charCodeAt(i))) i += 1
        i += i < n ? 1 : 0
        cut(start, i)
        continue
      }
      if (next === ']') {
        const start = i
        i += 2
        while (i < n && text[i] !== '\x07' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        if (i >= n) {
          cut(start, i)
          continue
        }
        i += text[i] === '\x07' ? 1 : 2
        cut(start, i)
        continue
      }
      if (next === '(' || next === ')' || next === '*' || next === '+') {
        const start = i
        i += Math.min(3, n - i)
        cut(start, i)
        continue
      }
      // DCS / SOS / PM / APC: ESC P / X / ^ / _ … ST
      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        const start = i
        i += 2
        while (i < n && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        i += i < n ? 2 : 0
        cut(start, i)
        continue
      }
    }
    const code = text.charCodeAt(i)
    if (code === 0x9b || code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f) {
      cut(i, i + 1)
      i += 1
      continue
    }
    i += 1
  }
  if (i > plainFrom) parts.push(text.slice(plainFrom, i))
  return parts.join('')
}

/**
 * ANSI-strip through the Rust binding when it exists (one string across the
 * napi bridge, the whole scan in Rust — see storage-core's `strip_ansi_text`),
 * through the JS twin above otherwise.
 */
export function stripAnsi(text: string): string {
  const fn = nativeStorageCore?.stripAnsiText
  if (typeof fn === 'function') {
    try {
      return fn.call(nativeStorageCore, text)
    } catch {
      /* fall through to JS below */
    }
  }
  return stripAnsiJs(text)
}
