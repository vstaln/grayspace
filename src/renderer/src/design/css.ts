/**
 * A very small style-object → stylesheet compiler, so the app's visual rules are
 * written in TypeScript instead of a hand-maintained `.css` file. It covers
 * exactly what this app needs and nothing more: nested selectors via `&`,
 * grouping at-rules (`@layer`, `@media`), and `@keyframes`.
 *
 * Values are emitted verbatim — this is a serializer, not a preprocessor, so
 * what you write is what the browser gets.
 */

export type StyleValue = string | number

export interface StyleRules {
  [propertyOrSelector: string]: StyleValue | StyleRules | undefined
}

/** A `selector → rules` map, optionally grouped under `@layer` / `@media`. */
export type Sheet = Record<string, StyleRules>

/** At-rules whose body is a selector map rather than a declaration block. */
const GROUPING_AT_RULE = /^@(layer|media|supports|container)\b/

/**
 * `backdropFilter` → `backdrop-filter`; `WebkitBackdropFilter` →
 * `-webkit-backdrop-filter` (the leading capital already produces the dash the
 * vendor prefix needs). Custom properties are passed through untouched.
 */
function toCssProperty(name: string): string {
  if (name.startsWith('--')) return name
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** Unitless numbers stay unitless; strings are already complete CSS values. */
function toCssValue(value: StyleValue): string {
  return typeof value === 'number' ? String(value) : value
}

function isRules(value: StyleValue | StyleRules | undefined): value is StyleRules {
  return typeof value === 'object' && value !== null
}

/**
 * Serializes one rule block, recursing into nested selectors. A nested key
 * containing `&` is substituted against the parent selector; anything else is
 * treated as a descendant (`.a { .b {} }` → `.a .b`).
 */
function serializeBlock(selector: string, rules: StyleRules): string {
  const declarations: string[] = []
  const nested: string[] = []

  for (const [key, value] of Object.entries(rules)) {
    if (value === undefined) continue

    if (isRules(value)) {
      if (key.startsWith('@keyframes')) nested.push(serializeKeyframes(key, value))
      // A nested at-rule re-states the current selector inside itself.
      else if (key.startsWith('@')) nested.push(`${key}{${serializeBlock(selector, value)}}`)
      else nested.push(serializeBlock(key.includes('&') ? key.replace(/&/g, selector) : `${selector} ${key}`, value))
      continue
    }

    declarations.push(`${toCssProperty(key)}:${toCssValue(value)}`)
  }

  return (declarations.length > 0 ? `${selector}{${declarations.join(';')}}` : '') + nested.join('')
}

function serializeKeyframes(atRule: string, frames: StyleRules): string {
  const steps = Object.entries(frames)
    .filter((entry): entry is [string, StyleRules] => isRules(entry[1]))
    .map(([step, value]) => {
      const declarations = Object.entries(value)
        .filter(([, v]) => v !== undefined && !isRules(v))
        .map(([prop, v]) => `${toCssProperty(prop)}:${toCssValue(v as StyleValue)}`)
      return `${step}{${declarations.join(';')}}`
    })
  return `${atRule}{${steps.join('')}}`
}

/** Compiles a sheet into a single stylesheet string. */
export function compile(sheet: Sheet): string {
  return Object.entries(sheet)
    .map(([key, rules]) => {
      if (key.startsWith('@keyframes')) return serializeKeyframes(key, rules)
      // `@layer components { … }` wraps a whole selector map, so it recurses as
      // a sheet rather than as a declaration block with a parent selector.
      if (GROUPING_AT_RULE.test(key)) return `${key}{${compile(rules as Sheet)}}`
      return serializeBlock(key, rules)
    })
    .join('')
}

/**
 * Mounts (or replaces) a stylesheet under a stable id. Replacing rather than
 * appending keeps hot-reload from stacking duplicate copies of the same rules.
 */
export function inject(id: string, sheet: Sheet): void {
  const css = compile(sheet)
  let element = document.getElementById(id) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = id
    document.head.appendChild(element)
  }
  if (element.textContent !== css) element.textContent = css
}
