/**
 * Typed handles in MCP tool arguments (lib/handles has the format): a
 * `je_...`/`inv_...` handle an agent got from the REST API is read as the
 * plain UUID every tool expects, once, at the dispatcher, before the company
 * is resolved and the tool runs. A handle of the wrong type for its argument
 * is refused with HANDLE_TYPE_MISMATCH. Arguments without handles come back
 * as the same object. Tool output is unchanged: tools still answer UUIDs.
 *
 * The advertised schemas say the same (handleAwareInputSchema): an id field
 * that admitted only a UUID admits its own type's handle too, so a host that
 * enforces JSON Schema formats or patterns lets the handle reach the
 * dispatcher instead of refusing it on the client.
 */
import {
  handleResource,
  normalizeHandleFields,
  toHandle,
  typeForField,
  type FieldTypeOverrides,
  type HandleType,
} from '@/lib/handles'
import { codedRefusal } from '@/lib/errors/refusal'

/**
 * Where MCP names a field differently from the REST API: the approve and
 * reject tools take a pending operation as `operation_id` (on REST that name
 * is an async operation, which takes no handle in a body).
 */
export const MCP_HANDLE_FIELD_OVERRIDES: FieldTypeOverrides = Object.freeze({
  operation_id: 'pending_operation',
})

/** The arguments with handles replaced by UUIDs; throws HANDLE_TYPE_MISMATCH on a wrong-type handle. */
export function normalizeToolArgHandles(args: Record<string, unknown>): Record<string, unknown> {
  const result = normalizeHandleFields(args, MCP_HANDLE_FIELD_OVERRIDES)
  if (result.ok) return result.value
  throw codedRefusal('HANDLE_TYPE_MISMATCH', result.mismatches.map((m) => m.message).join(' '))
}

// ──────────────────────────────────────────────────────────────────
// Advertised schemas: a typed id field admits its handle
// ──────────────────────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>

/** Tells a UUID-only restriction from a pattern for some other kind of key. */
const SAMPLE_UUID = '0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b'

const PATTERNS = new Map<HandleType, string>()

/**
 * The pattern a typed id field advertises: its type's handle, or a UUID.
 * The handle branch is exact. The UUID branch is the UUID's alphabet and
 * length, not its 8-4-4-4-12 grouping: the string ships in tools/list on
 * every id field it replaces, and the dispatcher checks the exact shape
 * anyway. Built once per type and reused.
 */
export function handleOrUuidPattern(type: HandleType): string {
  let pattern = PATTERNS.get(type)
  if (pattern === undefined) {
    pattern = `^(${handleResource(type).prefix}_[0-9a-f]{32}|[-0-9a-fA-F]{36})$`
    PATTERNS.set(type, pattern)
  }
  return pattern
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Does the pattern admit the value? A pattern this engine cannot read is left alone. */
function admits(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    return true
  }
}

/**
 * One id's schema with a UUID-only restriction (`format: 'uuid'`, or a
 * pattern that admits a UUID and refuses the handle) swapped for the
 * handle-or-UUID pattern. No restriction, or a pattern for another kind of
 * key (one that refuses a UUID too), is left as it is.
 */
function admitHandle(schema: JsonSchema, type: HandleType): JsonSchema {
  const pattern = typeof schema.pattern === 'string' ? schema.pattern : undefined
  if (pattern !== undefined && !admits(pattern, SAMPLE_UUID)) return schema
  const patternRefusesHandle = pattern !== undefined && !admits(pattern, toHandle(type, SAMPLE_UUID)!)
  if (schema.format !== 'uuid' && !patternRefusesHandle) return schema
  const { format: _format, pattern: _pattern, ...rest } = schema
  return { ...rest, pattern: handleOrUuidPattern(type) }
}

/** A typed field's schema: one id, a list of ids (`*_ids`), or a union of those. */
function typedFieldSchema(schema: JsonSchema, type: HandleType): JsonSchema {
  let next = admitHandle(schema, type)
  if (isObject(next.items)) {
    const items = typedFieldSchema(next.items, type)
    if (items !== next.items) next = { ...next, items }
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = next[key]
    if (!Array.isArray(options)) continue
    const mapped = options.map((o) => (isObject(o) ? typedFieldSchema(o, type) : o))
    if (mapped.some((o, i) => o !== options[i])) next = { ...next, [key]: mapped }
  }
  return next
}

/** Any schema node: typed fields are found under `properties`, at any depth. */
function visit(node: unknown): unknown {
  if (Array.isArray(node)) {
    const mapped = node.map(visit)
    return mapped.some((v, i) => v !== node[i]) ? mapped : node
  }
  if (!isObject(node)) return node
  let out: JsonSchema | undefined
  for (const [key, value] of Object.entries(node)) {
    const next = key === 'properties' && isObject(value) ? visitProperties(value) : visit(value)
    if (next !== value) {
      out ??= { ...node }
      out[key] = next
    }
  }
  return out ?? node
}

function visitProperties(properties: JsonSchema): JsonSchema {
  let out: JsonSchema | undefined
  for (const [name, schema] of Object.entries(properties)) {
    if (!isObject(schema)) continue
    const type = typeForField(name, MCP_HANDLE_FIELD_OVERRIDES)
    const next = type === undefined ? visit(schema) : typedFieldSchema(schema, type)
    if (next !== schema) {
      out ??= { ...properties }
      out[name] = next
    }
  }
  return out ?? properties
}

const ADVERTISED = new WeakMap<JsonSchema, JsonSchema>()

/**
 * A tool's inputSchema as hosts are shown it: every field the dispatcher
 * reads as a typed id (the same field-name rule, MCP_HANDLE_FIELD_OVERRIDES
 * included) admits its type's handle wherever it admitted only a UUID. The
 * same object when nothing changes. Memoised per schema object, so tools/list
 * does not walk the catalog on every call.
 */
export function handleAwareInputSchema(inputSchema: JsonSchema): JsonSchema {
  const cached = ADVERTISED.get(inputSchema)
  if (cached) return cached
  const advertised = visit(inputSchema) as JsonSchema
  ADVERTISED.set(inputSchema, advertised)
  return advertised
}
