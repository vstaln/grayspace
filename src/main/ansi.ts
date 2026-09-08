import * as electron from 'electron'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app
const ansiModuleDir = dirname(fileURLToPath(import.meta.url))

type NativeStorageCore = {

  stripAnsiText?(text: string): string
}

const nativeStorageCore = ((): NativeStorageCore | null => {
  try {
    const require = createRequire(import.meta.url)


    const nativeDir = electronApp?.isPackaged
      ? join(process.resourcesPath, 'native', 'storage-core')
      : join(ansiModuleDir, '../../native/storage-core')
    return require(nativeDir) as NativeStorageCore
  } catch {


    return null
  }
})()













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
        while (i < n && text[i] !== '\x07' && text[i] !== '\x9c' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        if (i >= n) {
          cut(start, i)
          continue
        }
        i += text[i] === '\x07' || text[i] === '\x9c' ? 1 : 2
        cut(start, i)
        continue
      }
      if (next === '(' || next === ')' || next === '*' || next === '+') {
        const start = i
        i += Math.min(3, n - i)
        cut(start, i)
        continue
      }

      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        const start = i
        i += 2
        while (i < n && text[i] !== '\x9c' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        if (i < n) i += text[i] === '\x9c' ? 1 : 2
        cut(start, i)
        continue
      }
    }
    const code = text.charCodeAt(i)
    if (code === 0x9b) {
      const start = i
      i += 1
      while (i < n && !isFinal(text.charCodeAt(i))) i += 1
      if (i < n) i += 1
      cut(start, i)
      continue
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      const start = i
      i += 1
      while (i < n && text[i] !== '\x9c' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
      if (i < n) i += text[i] === '\x9c' ? 1 : 2
      cut(start, i)
      continue
    }
    if (code === 0x9c) {
      cut(i, i + 1)
      i += 1
      continue
    }
    i += 1
  }
  if (i > plainFrom) parts.push(text.slice(plainFrom, i))
  return parts.join('')
}






export function stripAnsi(text: string): string {
  const fn = nativeStorageCore?.stripAnsiText
  if (typeof fn === 'function') {
    try {
      return fn.call(nativeStorageCore, text)
    } catch {

    }
  }
  return stripAnsiJs(text)
}






export function preserveSgr(text: string): string {
  const parts: string[] = []
  let plainFrom = 0
  let i = 0
  const n = text.length
  const isFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e
  const cut = (upTo: number, resumeAt: number, keep = false): void => {
    if (upTo > plainFrom) parts.push(text.slice(plainFrom, upTo))
    if (keep) parts.push(text.slice(upTo, resumeAt))
    plainFrom = resumeAt
  }

  while (i < n) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const start = i
      i += 2
      while (i < n && !isFinal(text.charCodeAt(i))) i += 1
      if (i < n) {
        const keep = text[i] === 'm'
        i += 1
        cut(start, i, keep)
      } else {
        cut(start, i)
      }
      continue
    }
    if (text.charCodeAt(i) === 0x9b) {
      const start = i
      i += 1
      while (i < n && !isFinal(text.charCodeAt(i))) i += 1
      if (i < n) {
        const keep = text[i] === 'm'
        i += 1
        cut(start, i, keep)
      } else {
        cut(start, i)
      }
      continue
    }
    if (text.charCodeAt(i) === 0x9d || text.charCodeAt(i) === 0x90 ||
      text.charCodeAt(i) === 0x98 || text.charCodeAt(i) === 0x9e || text.charCodeAt(i) === 0x9f) {
      const start = i
      i += 1
      while (i < n && text[i] !== '\x9c' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
      if (i < n) i += text[i] === '\x9c' ? 1 : 2
      cut(start, i)
      continue
    }
    if (text.charCodeAt(i) === 0x9c) {
      cut(i, i + 1)
      i += 1
      continue
    }
    if (text[i] === '\x1b' && i + 1 < n) {
      const next = text[i + 1]
      const start = i
      if (next === ']') {
        i += 2
        while (i < n && text[i] !== '\x07' && text[i] !== '\x9c' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        if (i < n) i += text[i] === '\x07' || text[i] === '\x9c' ? 1 : 2
      } else if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        i += 2
        while (i < n && text[i] !== '\x9c' && !(text[i] === '\x1b' && text[i + 1] === '\\')) i += 1
        if (i < n) i += text[i] === '\x9c' ? 1 : 2
      } else {
        i += next === '[' || next === ']' ? 2 : Math.min(3, n - i)
      }
      cut(start, i)
      continue
    }
    i += 1
  }
  if (i > plainFrom) parts.push(text.slice(plainFrom, i))
  return parts.join('')
}
