









export type StyleValue = string | number

export interface StyleRules {
  [propertyOrSelector: string]: StyleValue | StyleRules | undefined
}


export type Sheet = Record<string, StyleRules>


const GROUPING_AT_RULE = /^@(layer|media|supports|container)\b/






function toCssProperty(name: string): string {
  if (name.startsWith('--')) return name
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}


function toCssValue(value: StyleValue): string {
  return typeof value === 'number' ? String(value) : value
}

function isRules(value: StyleValue | StyleRules | undefined): value is StyleRules {
  return typeof value === 'object' && value !== null
}






function serializeBlock(selector: string, rules: StyleRules): string {
  const declarations: string[] = []
  const nested: string[] = []

  for (const [key, value] of Object.entries(rules)) {
    if (value === undefined) continue

    if (isRules(value)) {
      if (key.startsWith('@keyframes')) nested.push(serializeKeyframes(key, value))
      else if (key.startsWith('@')) nested.push(`${key}{${serializeBlock(selector, value)}}`)
      else {
        const expanded = key.includes('&')
          ? key
              .split(',')
              .map((part) =>
                selector
                  .split(',')
                  .map((sel) => part.trim().replace(/&/g, sel.trim()))
                  .join(', ')
              )
              .join(', ')
          : selector
              .split(',')
              .map((sel) => `${sel.trim()} ${key.trim()}`)
              .join(', ')
        nested.push(serializeBlock(expanded, value))
      }
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


export function compile(sheet: Sheet): string {
  return Object.entries(sheet)
    .map(([key, rules]) => {
      if (key.startsWith('@keyframes')) return serializeKeyframes(key, rules)


      if (GROUPING_AT_RULE.test(key)) return `${key}{${compile(rules as Sheet)}}`
      return serializeBlock(key, rules)
    })
    .join('')
}





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
