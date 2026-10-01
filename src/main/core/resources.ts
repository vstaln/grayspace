import { RESOURCE_SCHEMES, type ParsedResource, type ResourceId, type ResourceScheme } from './types.ts'

const SCHEMES = new Set<string>(RESOURCE_SCHEMES)






export function parseResource(target: ResourceId): ParsedResource | null {
  if (typeof target !== 'string') return null
  const at = target.indexOf(':')
  if (at <= 0) return null
  const scheme = target.slice(0, at)
  const id = target.slice(at + 1)
  if (!SCHEMES.has(scheme) || !id) return null
  return { scheme: scheme as ResourceScheme, id }
}

export function resourceId(scheme: ResourceScheme, id: string): ResourceId {
  return `${scheme}:${id}`
}







/** Normalize equivalent Windows spellings while preserving POSIX path case. */
export function fileResource(path: string): ResourceId {
  const unified = path.replace(/\\/g, '/')
  const drive = /^([a-z]:)(.*)$/i.exec(unified)
  let normalized: string
  if (drive) {
    const rest = drive[2].replace(/\/+$/, '')
    let suffix = rest.toLowerCase()
    if (rest.startsWith('/')) suffix = `/${rest.slice(1).toLowerCase()}`
    if (!rest && drive[2].startsWith('/')) suffix = '/'
    normalized = `${drive[1][0].toUpperCase()}:${suffix}`
  } else if (unified.startsWith('//')) {
    normalized = unified.replace(/\/+$/, '').toLowerCase() || '//'
  } else if (unified.startsWith('/')) {
    normalized = unified.replace(/\/+$/, '') || '/'
  } else {
    normalized = unified.replace(/\/+$/, '')
  }
  return resourceId('file', normalized)
}

export function isResourceId(value: unknown): value is ResourceId {
  return typeof value === 'string' && parseResource(value) !== null
}
