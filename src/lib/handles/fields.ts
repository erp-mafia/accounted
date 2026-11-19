/**
 * Which request field holds which kind of id, and the normalisation that
 * turns the handles in a request into the plain UUIDs every handler,
 * schema and query below it expects (./registry.ts has the format).
 *
 * The field name decides the type. The API's id fields are qualified by
 * convention (`journal_entry_id`, never a bare `id`), so the name already
 * says what the id is: `<base>_id` / `<base>_ids` for a base in the registry,
 * with any role in front (`credited_invoice_id`, `expected_journal_entry_ids`,
 * `previous_period_id`). The longest base wins, so `supplier_invoice_id` is a
 * supplier invoice, never an invoice. Doing it by name, once per surface (the
 * v1 wrapper, the MCP dispatcher), covers every route and tool, hand-written
 * or generated, without touching their schemas.
 *
 * What it changes, and what it never does:
 *   - A handle of the field's own type becomes its UUID.
 *   - A handle of a known prefix and ANOTHER type is a mismatch: the caller
 *     gets HANDLE_TYPE_MISMATCH instead of a lookup that fails far away.
 *   - A plain UUID, any other value, and every field whose name is not a
 *     typed id field are left exactly as sent. A request without handles
 *     comes out identical (same object), so existing callers see no change.
 *
 * Not typed, on purpose: fields holding someone else's id (`external_*`,
 * `provider_*`) and the names whose last word is a typed base but which name
 * another table (NON_ID_FIELDS).
 */
import { parseHandle, type ParsedHandle } from './format'
import { HANDLE_RESOURCES, handleResource, type HandleType } from './registry'

/** Prefixes of fields that carry an id from outside Accounted. */
const FOREIGN_FIELD_PREFIXES = ['external_', 'provider_'] as const

/**
 * Field names ending in a typed base that hold another table's id: a salary
 * run's employee row is not an employee, a skattekonto transaction is not a
 * bank transaction.
 */
const NON_ID_FIELDS = new Set([
  'salary_run_employee_id',
  'salary_run_employee_ids',
  'skattekonto_transaction_id',
  'skattekonto_transaction_ids',
])

/**
 * Unqualified names that hold one type's id wherever the API uses them: a
 * dimension rule names its dimension value `value_id` (v1 and MCP alike).
 */
const EXACT_FIELD_TYPES: Readonly<Record<string, HandleType>> = {
  value_id: 'dimension_value',
}

/** [base, type], longest base first so the most specific suffix wins. */
const FIELD_BASES: ReadonlyArray<readonly [string, HandleType]> = HANDLE_RESOURCES.flatMap((r) =>
  r.fields.map((base) => [base, r.type as HandleType] as const),
).sort((a, b) => b[0].length - a[0].length)

/** Per-surface exceptions: a field name the surface types differently. */
export type FieldTypeOverrides = Readonly<Record<string, HandleType | null>>

/**
 * The id type a request field holds, or undefined when the field is not a
 * typed id field. `overrides` lets a surface name its own exceptions (MCP's
 * `operation_id` is a pending operation).
 */
export function typeForField(key: string, overrides?: FieldTypeOverrides): HandleType | undefined {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
    return overrides[key] ?? undefined
  }
  if (Object.prototype.hasOwnProperty.call(EXACT_FIELD_TYPES, key)) return EXACT_FIELD_TYPES[key]
  if (NON_ID_FIELDS.has(key)) return undefined
  if (FOREIGN_FIELD_PREFIXES.some((p) => key.startsWith(p))) return undefined
  for (const [base, type] of FIELD_BASES) {
    for (const suffix of [`${base}_id`, `${base}_ids`]) {
      if (key === suffix || key.endsWith(`_${suffix}`)) return type
    }
  }
  return undefined
}

/** A handle sent where another type (or a plain UUID) is expected. */
export interface HandleMismatch {
  /** Where: a dotted body path (`items.0.invoice_id`), a query key or `path.<param>`. */
  field: string
  /** The type the field takes; null for a parameter that takes a plain UUID only. */
  expected_type: HandleType | null
  /** That type's prefix; null for a plain-UUID parameter. */
  expected_prefix: string | null
  /** The type and prefix of the handle that was sent. */
  received_type: HandleType
  received_prefix: string
  /** English, for message_en-style display and the issues list. */
  message: string
}

export function mismatchFor(field: string, expected: HandleType | null, received: ParsedHandle): HandleMismatch {
  const want = expected === null ? null : handleResource(expected)
  const got = handleResource(received.type)
  return {
    field,
    expected_type: expected,
    expected_prefix: want?.prefix ?? null,
    received_type: received.type,
    received_prefix: received.prefix,
    message: want
      ? `${field} takes ${withArticle(want.label)} id (a ${want.prefix}_ handle or a plain UUID); the ${got.prefix}_ handle sent names ${withArticle(got.label)}.`
      : `${field} takes a plain UUID; the ${got.prefix}_ handle sent names ${withArticle(got.label)}.`,
  }
}

function withArticle(label: string): string {
  return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`
}

/**
 * One id value for an expected type: the UUID when it is a handle of that
 * type, the value unchanged when it is not a handle, a mismatch otherwise.
 */
export function resolveIdValue(
  value: unknown,
  expected: HandleType | null,
  field: string,
): { value: unknown; changed: boolean } | { mismatch: HandleMismatch } {
  const parsed = parseHandle(value)
  if (!parsed) return { value, changed: false }
  if (parsed.type !== expected) return { mismatch: mismatchFor(field, expected, parsed) }
  return { value: parsed.uuid, changed: true }
}

/** The normalised value, or the mismatches that refuse the request. */
export type NormalizeResult<T> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; mismatches: HandleMismatch[] }

/**
 * Turn the handles in a JSON value (a request body, MCP arguments) into
 * UUIDs, recursing through objects and arrays. Only typed id fields are
 * read; see the module comment for what is left alone. Returns the input
 * object itself when nothing changed.
 */
export function normalizeHandleFields<T>(input: T, overrides?: FieldTypeOverrides): NormalizeResult<T> {
  const mismatches: HandleMismatch[] = []

  const visit = (node: unknown, path: string): { value: unknown; changed: boolean } => {
    if (Array.isArray(node)) {
      let changed = false
      const out = node.map((item, i) => {
        const r = visit(item, path ? `${path}.${i}` : String(i))
        changed ||= r.changed
        return r.value
      })
      return changed ? { value: out, changed } : { value: node, changed: false }
    }
    if (node === null || typeof node !== 'object') return { value: node, changed: false }

    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(node as Record<string, unknown>)) {
      const field = path ? `${path}.${key}` : key
      const type = typeForField(key, overrides)
      if (type !== undefined && (typeof raw === 'string' || Array.isArray(raw))) {
        const resolved = resolveIdField(raw, type, field, mismatches)
        out[key] = resolved.value
        changed ||= resolved.changed
        continue
      }
      const r = visit(raw, field)
      out[key] = r.value
      changed ||= r.changed
    }
    return changed ? { value: out, changed } : { value: node, changed: false }
  }

  const result = visit(input, '')
  if (mismatches.length > 0) return { ok: false, mismatches }
  return { ok: true, value: result.value as T, changed: result.changed }
}

/** A typed id field's value: one id, or a list of ids (`*_ids`). */
function resolveIdField(
  raw: string | unknown[],
  type: HandleType,
  field: string,
  mismatches: HandleMismatch[],
): { value: unknown; changed: boolean } {
  if (typeof raw === 'string') {
    const r = resolveIdValue(raw, type, field)
    if ('mismatch' in r) {
      mismatches.push(r.mismatch)
      return { value: raw, changed: false }
    }
    return r
  }
  let changed = false
  const out = raw.map((item, i) => {
    const r = resolveIdValue(item, type, `${field}.${i}`)
    if ('mismatch' in r) {
      mismatches.push(r.mismatch)
      return item
    }
    changed ||= r.changed
    return r.value
  })
  return changed ? { value: out, changed } : { value: raw, changed: false }
}

/**
 * A query-string (or multipart text field) value of a typed id field: one
 * id, or a comma-separated list for a `*_ids` field. Returns the value
 * unchanged when it holds no handle.
 */
export function normalizeQueryValue(
  key: string,
  value: string,
  overrides?: FieldTypeOverrides,
): { value: string; changed: boolean } | { mismatches: HandleMismatch[] } {
  const type = typeForField(key, overrides)
  if (type === undefined) return { value, changed: false }
  const parts = key.endsWith('_ids') ? value.split(',') : [value]
  const mismatches: HandleMismatch[] = []
  let changed = false
  const out = parts.map((part) => {
    const r = resolveIdValue(part.trim(), type, key)
    if ('mismatch' in r) {
      mismatches.push(r.mismatch)
      return part
    }
    if (!r.changed) return part
    changed = true
    return r.value as string
  })
  if (mismatches.length > 0) return { mismatches }
  return changed ? { value: out.join(','), changed } : { value, changed: false }
}
