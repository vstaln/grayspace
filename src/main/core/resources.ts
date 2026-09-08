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







export function fileResource(path: string): ResourceId {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const withDrive = /^[a-z]:\//i.test(unified) ? unified[0].toUpperCase() + unified.slice(1) : unified


  const slash = withDrive.indexOf('/')
  const normalized =
    slash >= 0 ? withDrive.slice(0, slash + 1) + withDrive.slice(slash + 1).toLowerCase() : withDrive.toLowerCase()
  return resourceId('file', normalized)
}

export function isResourceId(value: unknown): value is ResourceId {
  return typeof value === 'string' && parseResource(value) !== null
}
