/**
 * Untrusted JSON parsing with prototype-pollution defenses.
 *
 * `JSON.parse` on an attacker-controlled string lets a payload with
 * `{"__proto__": {"polluted": true}}` add properties to `Object.prototype`,
 * which every plain object inherits. Our IPC reads user input (localStorage
 * from any widget, the loopback HTTP body, hand-edited store files) and
 * would have spread a pollute-once to the whole renderer on the next
 * render. The fix is to drop poisoned keys during parsing and to walk the
 * parsed value to copy any remaining poisoned keys onto safe own properties.
 *
 * Use `safeParseJson` for any input that crosses a trust boundary. Use the
 * bare `JSON.parse` only for trusted internal payloads (the journal itself,
 * the data *we* wrote).
 */
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

/**
 * JSON.parse reviver that drops poisoned prototype-bearing keys before they
 * can be used to mutate Object.prototype. Modern engines already turn
 * `__proto__` into an own property, but we drop it here too for defense in
 * depth and to also strip `constructor`/`prototype`.
 */
function dropPoisonedKeys(key: string, value: unknown): unknown {
  if (POISONED_KEYS.has(key)) return undefined
  return value
}

/**
 * Parse then re-walk the result, replacing any poisoned prototype-bearing
 * object with a plain object. Cheaper than deep-cloning and safe for
 * arbitrary JSON shapes including arrays and primitives.
 */
/** Deep store JSON nests far below this; deeper means attack, not data. */
const MAX_WALK_DEPTH = 200

export function sanitizeParsed<T>(value: T): T {
  try {
    return walk(value, new WeakSet(), 0) as T
  } catch {
    // Absurd depth (or a getter throwing mid-walk) degrades to the raw value
    // rather than a RangeError propagating into a store load path.
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
  // For every poisoned key, copy the value into a same-named own property on
  // the existing object, then null out the inherited one. The original prototype
  // stays intact on every other object; only this one instance is touched.
  // We only act on keys the source object actually owns — checking inherited
  // keys would shadow Object.prototype.constructor on every plain object and
  // break deep-equal comparisons against literal defaults.
  for (const k of POISONED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue
    const v = (value as Record<string, unknown>)[k]
    try {
      Object.defineProperty(value, k, { value: walk(v, seen, depth + 1), writable: true, enumerable: true, configurable: true })
    } catch {
      // The host object is frozen or the descriptor is read-only; we still
      // copy any non-poisoned keys below, so failure here is recoverable.
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