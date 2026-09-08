














const POISONED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function safeParseJson<T = unknown>(text: string): T | null {
  if (typeof text !== 'string' || !text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text, dropPoisonedKeys) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return parsed as T
  return sanitizeParsed(parsed) as T
}







function dropPoisonedKeys(key: string, value: unknown): unknown {
  if (POISONED_KEYS.has(key)) return undefined
  return value
}







const MAX_WALK_DEPTH = 200

export function sanitizeParsed<T>(value: T): T {
  try {
    return walk(value, new WeakSet(), 0) as T
  } catch {


    return value
  }
}

function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_WALK_DEPTH) throw new Error('walk depth exceeded')
  if (seen.has(value as object)) return value
  seen.add(value as object)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = walk(value[i], seen, depth + 1)
    return value
  }






  for (const k of POISONED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue
    const v = (value as Record<string, unknown>)[k]
    try {
      Object.defineProperty(value, k, { value: walk(v, seen, depth + 1), writable: true, enumerable: true, configurable: true })
    } catch {


    }
  }
  for (const key of Object.keys(value as object)) {
    if (POISONED_KEYS.has(key)) continue
    ;(value as Record<string, unknown>)[key] = walk(
      (value as Record<string, unknown>)[key],
      seen,
      depth + 1
    )
  }
  return value
}
