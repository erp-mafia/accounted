import { describe, it, expect } from 'vitest'
import { SCHEMAS, fieldKinds, jsonSchemaFor, schemaForType } from '../schemas'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'

const FIRST_SIX = ['agreement.rental', 'agreement.lease', 'agreement.loan', 'agreement.subscription', 'registration.bolagsverket', 'decision.skatteverket']

describe('extraction schemas', () => {
  it('reads the six first types with their own schema and every other type with the generic one', () => {
    for (const type of FIRST_SIX) expect(schemaForType(type).schemaType).toBe(type)
    expect(Object.keys(SCHEMAS).sort()).toEqual([...FIRST_SIX, 'generic'].sort())
    for (const type of FIRST_SIX) expect(DOC_TYPES).toContain(type)
    expect(schemaForType('receipt').schemaType).toBe('generic')
    expect(schemaForType(null).schemaType).toBe('generic')
  })

  it('gives every schema unique field names, a version, and options for every enum', () => {
    for (const def of Object.values(SCHEMAS)) {
      const names = def.fields.map((f) => f.name)
      expect(new Set(names).size).toBe(names.length)
      expect(def.version).toBeGreaterThanOrEqual(1)
      if (def.schemaType !== 'generic') expect(def.fields.some((f) => f.required)).toBe(true)
      for (const f of def.fields) if (f.kind === 'enum') expect(f.options?.length).toBeGreaterThan(0)
    }
  })

  it('builds a grounded JSON schema: every field is a required {value, page, quote}', () => {
    const def = SCHEMAS['decision.skatteverket']
    const schema = jsonSchemaFor(def) as {
      required: string[]
      properties: Record<string, { required: string[]; properties: { value: { enum?: unknown[]; type: unknown } } }>
    }
    expect(schema.required).toEqual(def.fields.map((f) => f.name))
    expect(schema.properties.f_skatt.required).toEqual(['value', 'page', 'quote'])
    expect(schema.properties.f_skatt.properties.value.enum).toEqual(['approved', 'not_approved', 'unknown', null])
    expect(schema.properties.amount.properties.value.type).toEqual(['number', 'null'])
    expect(fieldKinds(def).amount).toBe('amount')
  })
})
