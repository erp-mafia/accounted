/**
 * The advertised MCP input schemas admit typed handles where the dispatcher
 * does (handle-args.ts): a host that enforces JSON Schema formats or
 * patterns must never refuse, on the client, a handle the server would
 * accept. Walks every tool's inputSchema as tools/list and
 * gnubok_search_tools show it (projectToolInputSchema, with and without
 * company_id) and checks each field the dispatcher reads as a typed id.
 */
import { describe, expect, it } from 'vitest'
import { toHandle, typeForField, type HandleType } from '@/lib/handles'
import { UUID_RE } from '@/lib/invariants/uuid'
import { tools } from '../server'
import { projectToolInputSchema } from '../company-routing'
import { MCP_HANDLE_FIELD_OVERRIDES, handleAwareInputSchema, handleOrUuidPattern } from '../handle-args'

type Schema = Record<string, unknown>

const UUID = '0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b'

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Would a validator that asserts formats and patterns accept the value?
 * Covers the keywords an id field uses; any format other than uuid counts
 * as a refusal, so an unexpected one fails loudly instead of passing.
 */
function admits(schema: unknown, value: unknown): boolean {
  if (!isObject(schema)) return true
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    if (!types.includes(actual)) return false
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if ('const' in schema && schema.const !== value) return false
  if (typeof value === 'string') {
    if (schema.format !== undefined && !(schema.format === 'uuid' && UUID_RE.test(value))) return false
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return false
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false
  }
  if (Array.isArray(value) && isObject(schema.items) && !value.every((v) => admits(schema.items, v))) return false
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => admits(s, value))) return false
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((s) => admits(s, value))) return false
  if (Array.isArray(schema.allOf) && !schema.allOf.every((s) => admits(s, value))) return false
  return true
}

interface TypedField {
  where: string
  type: HandleType
  schema: Schema
}

/** Every property the dispatcher reads as a typed id, at any depth. */
function typedFields(node: unknown, where: string, out: TypedField[] = []): TypedField[] {
  if (Array.isArray(node)) {
    node.forEach((child) => typedFields(child, where, out))
    return out
  }
  if (!isObject(node)) return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isObject(value)) {
      for (const [name, schema] of Object.entries(value)) {
        if (!isObject(schema)) continue
        const type = typeForField(name, MCP_HANDLE_FIELD_OVERRIDES)
        if (type) out.push({ where: `${where}.${name}`, type, schema })
        else typedFields(schema, `${where}.${name}`, out)
      }
    } else {
      typedFields(value, where, out)
    }
  }
  return out
}

/** One id or a list of ids, in whichever shape the field takes a plain UUID. */
function asSent(field: TypedField, id: string): unknown {
  return admits(field.schema, id) ? id : [id]
}

describe('advertised MCP input schemas admit typed handles', () => {
  for (const omitCompanyId of [false, true]) {
    const catalog = omitCompanyId ? 'single-company catalog' : 'multi-company catalog'
    const fields = tools.flatMap((tool) =>
      typedFields(projectToolInputSchema(tool, { omitCompanyId }), tool.name),
    )

    it(`finds the typed id fields (${catalog})`, () => {
      // A walk that found nothing would pass everything below.
      expect(fields.length).toBeGreaterThan(200)
    })

    it(`takes a plain UUID, lower or upper case, in every typed id field (${catalog})`, () => {
      const refused = fields
        .filter((f) => !admits(f.schema, asSent(f, UUID)) || !admits(f.schema, asSent(f, UUID.toUpperCase())))
        .map((f) => f.where)
      expect(refused).toEqual([])
    })

    it(`takes the field's own handle in every typed id field (${catalog})`, () => {
      const refused = fields
        .filter((f) => !admits(f.schema, asSent(f, toHandle(f.type, UUID)!)))
        .map((f) => `${f.where} (${f.type})`)
      expect(refused, 'a host enforcing the schema would refuse a handle the dispatcher accepts').toEqual([])
    })
  }
})

describe('handleAwareInputSchema', () => {
  const FP = toHandle('fiscal_period', UUID)!
  const INV = toHandle('invoice', UUID)!

  it('returns the very same schema when no typed field is restricted to a UUID', () => {
    const schema = {
      type: 'object',
      properties: { invoice_id: { type: 'string' }, batch_id: { type: 'string', format: 'uuid' } },
    }
    expect(handleAwareInputSchema(schema)).toBe(schema)
  })

  it('swaps a uuid format for the type pattern, nested and in lists, without mutating the source', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', format: 'uuid', description: 'The year.' },
        journal_entry_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
        allocations: {
          type: 'array',
          items: { type: 'object', properties: { invoice_id: { type: ['string', 'null'], format: 'uuid' } } },
        },
        operation_id: { type: 'string', format: 'uuid' },
        batch_id: { type: 'string', format: 'uuid' },
      },
    }
    const before = JSON.stringify(schema)
    expect(handleAwareInputSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'The year.', pattern: handleOrUuidPattern('fiscal_period') },
        journal_entry_ids: { type: 'array', items: { type: 'string', pattern: handleOrUuidPattern('journal_entry') } },
        allocations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { invoice_id: { type: ['string', 'null'], pattern: handleOrUuidPattern('invoice') } },
          },
        },
        // MCP's approve and reject tools name a pending operation operation_id.
        operation_id: { type: 'string', pattern: handleOrUuidPattern('pending_operation') },
        // Not a typed id field: left exactly as it was.
        batch_id: { type: 'string', format: 'uuid' },
      },
    })
    expect(JSON.stringify(schema)).toBe(before)
  })

  it('swaps a UUID pattern, and leaves a pattern for another kind of key alone', () => {
    const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    const schema = {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', pattern: uuidPattern },
        document_id: { type: 'string', pattern: '^doc-[0-9]+$' },
      },
    }
    expect(handleAwareInputSchema(schema).properties).toEqual({
      invoice_id: { type: 'string', pattern: handleOrUuidPattern('invoice') },
      document_id: { type: 'string', pattern: '^doc-[0-9]+$' },
    })
  })

  it('advertises one pattern per type that refuses another type\'s handle', () => {
    const pattern = new RegExp(handleOrUuidPattern('fiscal_period'), 'u')
    expect(pattern.test(FP)).toBe(true)
    expect(pattern.test(UUID)).toBe(true)
    expect(pattern.test(UUID.toUpperCase())).toBe(true)
    expect(pattern.test(INV)).toBe(false)
    expect(pattern.test('2026')).toBe(false)
    expect(handleOrUuidPattern('fiscal_period')).toBe('^(fp_[0-9a-f]{32}|[-0-9a-fA-F]{36})$')
  })

  it('works out a schema once', () => {
    const schema = { type: 'object', properties: { invoice_id: { type: 'string', format: 'uuid' } } }
    expect(handleAwareInputSchema(schema)).toBe(handleAwareInputSchema(schema))
  })
})
