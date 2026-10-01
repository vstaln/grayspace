import * as http from 'http'
import { fileResource, parseResource } from '../core/index.ts'

export const CONTROL_BODY_LIMIT_BYTES = 1_000_000
export const CONTROL_BODY_TIMEOUT_MS = 30_000

export function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

export function normalizeLockResource(raw: unknown): string {
  const text = String(raw ?? '').trim()
  const parsed = parseResource(text)
  if (parsed?.scheme === 'file') return fileResource(parsed.id)
  if (/^[A-Za-z]:[\\/]/.test(text) || text.includes('\\') || text.startsWith('/')) return fileResource(text)
  return text
}

const parsedRequestBodies = new WeakMap<http.IncomingMessage, Promise<Record<string, unknown>>>()

export function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const cached = parsedRequestBodies.get(req)
  if (cached) return cached

  const parsedBody = new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const fail = (statusCode: number, message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chunks.length = 0
      const error = new Error(message) as Error & { statusCode: number }
      error.statusCode = statusCode
      reject(error)
    }
    const timer = setTimeout(() => fail(408, 'request body timed out'), CONTROL_BODY_TIMEOUT_MS)
    timer.unref?.()
    req.on('close', () => {
      if (!settled && !req.complete) fail(499, 'client closed request')
    })
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > CONTROL_BODY_LIMIT_BYTES) {
        fail(413, 'request body too large')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key: string, value: unknown) =>
          key === '__proto__' || key === 'prototype' || key === 'constructor' ? undefined : value
        )
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          const error = new Error('request body must be a JSON object') as Error & { statusCode: number }
          error.statusCode = 400
          reject(error)
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        const error = new Error('request body must be valid JSON') as Error & { statusCode: number }
        error.statusCode = 400
        reject(error)
      }
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
  parsedRequestBodies.set(req, parsedBody)
  return parsedBody
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): true {
  if (res.headersSent || res.destroyed || res.writableEnded) return true
  const body = JSON.stringify(data)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    })
    res.end(body)
  } catch {}
  return true
}

export function localDayKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function shiftLocalDay(key: string, delta: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + delta)
  return localDayKey(date)
}

export function uniqueProjects(items: { project?: string }[]): string[] {
  const seen = new Set<string>()
  const projects: string[] = []
  for (const item of items) {
    const project = item.project?.trim()
    if (!project || seen.has(project)) continue
    seen.add(project)
    projects.push(project)
  }
  return projects
}
