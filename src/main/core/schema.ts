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
  /** See CommandHandler.transient — skips the journal for hot, stateless commands. */
  transient?: boolean
  /** See CommandHandler.bypassQueue — skips the single-lane queue. */
  bypassQueue?: boolean
  handler?: CommandHandler<P, R>
}

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required: string[]
  }
}

/**
 * Validates an input payload against a CommandPayloadSchema.
 * Returns null if valid, or an error message if invalid.
 */
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

function fieldToMcpProperty(field: FieldSchema): Record<string, unknown> {
  const prop: Record<string, unknown> = {
    type: field.type === 'any' ? 'string' : field.type,
    description: field.description || ''
  }
  if (field.enum) prop.enum = [...field.enum]
  if (field.items) prop.items = fieldToMcpProperty(field.items)
  if (field.properties) {
    const nestedProps: Record<string, unknown> = {}
    for (const [k, f] of Object.entries(field.properties)) {
      nestedProps[k] = fieldToMcpProperty(f)
    }
    prop.properties = nestedProps
  }
  return prop
}

/**
 * Converts a CommandDefinition into a standardized MCP Tool Descriptor.
 */
export function definitionToMcpTool(def: CommandDefinition): McpToolDescriptor {
  const properties: Record<string, Record<string, unknown>> = {
    target: {
      type: 'string',
      description: `Target resource id (scheme: "${def.targetScheme}")`
    },
    baseVersion: {
      type: 'number',
      description: 'Expected base version for optimistic concurrency control (optional for creates)'
    }
  }

  for (const [key, field] of Object.entries(def.payloadSchema.properties)) {
    properties[key] = fieldToMcpProperty(field)
  }

  const required = ['target', ...(def.payloadSchema.required || [])]

  return {
    name: def.type.replace(/\./g, '_'),
    description: def.description,
    inputSchema: {
      type: 'object',
      properties,
      required
    }
  }
}
