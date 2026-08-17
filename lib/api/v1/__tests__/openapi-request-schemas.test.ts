/**
 * The OpenAPI generator emits machine-readable request contracts:
 * path `parameters` derived from the route pattern and `requestBody` from
 * the registered Zod body schema. Historically the spec only carried
 * response schemas + prose, which forced spec consumers (agent skills,
 * client generators) to guess request shapes.
 */

import { describe, expect, it } from 'vitest'
import { generateOpenApiSpec } from '../registry'
// Side-effect import: populates the ENDPOINTS registry from every route file.
import '../load-routes'

type OperationObject = {
  parameters?: Array<{ name: string; in: string; required: boolean; schema: unknown }>
  requestBody?: {
    required: boolean
    content: Record<string, { schema: { properties?: Record<string, unknown>; required?: string[] } }>
  }
}

const spec = generateOpenApiSpec('https://unit.test')

function operation(path: string, method: string): OperationObject {
  const op = (spec.paths[path] as Record<string, OperationObject> | undefined)?.[method]
  expect(op, `${method.toUpperCase()} ${path} missing from spec`).toBeDefined()
  return op as OperationObject
}

describe('generateOpenApiSpec request contracts', () => {
  it('declares a path parameter for every templated segment, on every operation', () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
      for (const [method, op] of Object.entries(item as Record<string, OperationObject>)) {
        const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name)
        expect(declared.sort(), `${method.toUpperCase()} ${path}`).toEqual([...templated].sort())
      }
    }
  })

  it('emits requestBody from the registered Zod body schema', () => {
    const op = operation('/api/v1/companies/{companyId}/invoices', 'post')
    expect(op.requestBody?.required).toBe(true)
    const schema = op.requestBody?.content['application/json']?.schema
    expect(schema?.properties).toHaveProperty('customer_id')
    expect(schema?.properties).toHaveProperty('items')
    expect(schema?.required).toContain('customer_id')
  })

  it('renders a z.preprocess field by its output schema and keeps it optional', () => {
    // CreateSupplierSchema wraps email and default_expense_account in a
    // preprocess pipe (empty string means absent). The callable sits on the
    // pipe's input side, so describing the input would yield a required
    // untyped field; the spec must show the output schema and not require it.
    const op = operation('/api/v1/companies/{companyId}/suppliers', 'post')
    const schema = op.requestBody?.content['application/json']?.schema
    expect(schema?.properties?.email).toEqual({ type: 'string' })
    expect(schema?.properties?.default_expense_account).toEqual({ type: 'string' })
    expect(schema?.required).toContain('name')
    expect(schema?.required).not.toContain('email')
    expect(schema?.required).not.toContain('default_expense_account')
  })

  it('renders multipart z.unknown() parts as binary file parts', () => {
    const op = operation('/api/v1/companies/{companyId}/documents', 'post')
    const schema = op.requestBody?.content['multipart/form-data']?.schema
    expect(schema?.properties?.file).toEqual({ type: 'string', format: 'binary' })
    // Non-file parts keep their real schema.
    expect(schema?.properties?.journal_entry_id).toMatchObject({ type: 'string' })
  })

  it('omits requestBody on endpoints without a registered body', () => {
    expect(operation('/api/v1/companies', 'get').requestBody).toBeUndefined()
  })

  it('converts wrapped Zod constructs (.default, z.record) instead of degrading to {}', () => {
    const op = operation('/api/v1/companies/{companyId}/journal-entries', 'post')
    const schema = op.requestBody?.content['application/json']?.schema as {
      properties: Record<string, { type?: string; enum?: unknown[]; items?: { properties: Record<string, { type?: string; additionalProperties?: unknown }> } }>
      required?: string[]
    }
    // JournalEntrySourceTypeSchema.default('manual'): enum survives, field not required.
    expect(schema.properties.source_type.enum).toContain('manual')
    expect(schema.required).not.toContain('source_type')
    const line = schema.properties.lines.items!.properties
    // nonNegativeAmount.default(0) is a number, and z.record renders as an
    // object with additionalProperties rather than an empty schema.
    expect(line.debit_amount.type).toBe('number')
    expect(line.dimensions.additionalProperties).toBeTruthy()
  })
})
