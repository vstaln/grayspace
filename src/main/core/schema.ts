import type { CommandHandler, ResourceScheme } from './types.ts'

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any'

export interface FieldSchema {
  type: FieldType
  description?: string
  required?: boolean
  items?: FieldSchema
  properties?: Record<string, FieldSchema>
  enum?: readonly (string | number)[]
  default?: unknown
}

export interface CommandPayloadSchema {
  type: 'object'
  properties: Record<string, FieldSchema>
  required?: readonly string[]
  additionalProperties?: boolean
}

export interface CommandDefinition<P = unknown, R = unknown> {
  type: string
  description: string
  targetScheme: ResourceScheme
  payloadSchema: CommandPayloadSchema
  requiresLock?: boolean
  ignoreVersion?: boolean

  transient?: boolean

  bypassQueue?: boolean
  handler?: CommandHandler<P, R>
}





export function validatePayload(schema: CommandPayloadSchema, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be a JSON object'
  }
  const obj = payload as Record<string, unknown>

  if (schema.required) {
    for (const req of schema.required) {
      if (obj[req] === undefined || obj[req] === null) {
        return `missing required field "${req}"`
      }
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in schema.properties)) {
        return `unexpected field "${key}"`
      }
    }
  }

  for (const [key, field] of Object.entries(schema.properties)) {
    const val = obj[key]
    if (val === undefined || val === null) continue

    if (field.enum && !field.enum.includes(val as never)) {
      return `field "${key}" must be one of [${field.enum.join(', ')}]`
    }

    if (field.type === 'string' && typeof val !== 'string') {
      return `field "${key}" must be a string`
    }
    if (field.type === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) {
      return `field "${key}" must be a finite number`
    }
    if (field.type === 'boolean' && typeof val !== 'boolean') {
      return `field "${key}" must be a boolean`
    }
    if (field.type === 'array' && !Array.isArray(val)) {
      return `field "${key}" must be an array`
    }
    if (field.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
      return `field "${key}" must be an object`
    }
  }

  return null
}
