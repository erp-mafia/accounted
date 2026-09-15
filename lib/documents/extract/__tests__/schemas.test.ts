import { describe, it, expect } from 'vitest'
import { SCHEMAS, fieldKinds, jsonSchemaFor, readingsFromAnswer, schemaForType } from '../schemas'
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

  it('gives every schema unique field names that never collide with a page or quote property, and real options for every enum', () => {
    for (const def of Object.values(SCHEMAS)) {
      const names = new Set(def.fields.map((f) => f.name))
      expect(names.size).toBe(def.fields.length)
      expect(def.version).toBeGreaterThanOrEqual(1)
      if (def.schemaType !== 'generic') expect(def.fields.some((f) => f.required)).toBe(true)
      for (const f of def.fields) {
        expect(names.has(`${f.name}_page`) || names.has(`${f.name}_quote`)).toBe(false)
        if (f.kind === 'enum') {
          expect(f.options?.length).toBeGreaterThan(0)
          expect(f.options).not.toContain('unknown')
        }
      }
    }
  })

  it('builds a flat grounded JSON schema: value, page and quote per field, all required, nothing nested', () => {
    const def = SCHEMAS['decision.skatteverket']
    const schema = jsonSchemaFor(def) as { required: string[]; properties: Record<string, { type: unknown; enum?: unknown[] }> }
    expect(schema.required).toEqual(def.fields.flatMap((f) => [f.name, `${f.name}_page`, `${f.name}_quote`]))
    expect(schema.properties.f_skatt.enum).toEqual(['approved', 'not_approved', null])
    expect(schema.properties.amount.type).toEqual(['number', 'null'])
    expect(schema.properties.amount_page.type).toEqual(['integer', 'null'])
    expect(Object.values(schema.properties).some((p) => p.type === 'object')).toBe(false)
    expect(fieldKinds(def).amount).toBe('amount')
  })

  it('reads a flat answer back as one reading per field', () => {
    const def = SCHEMAS['agreement.loan']
    const readings = readingsFromAnswer(def, { principal: 500000, principal_page: 1, principal_quote: 'Kreditbelopp 500 000 kr' })
    expect(readings.principal).toEqual({ value: 500000, page: 1, quote: 'Kreditbelopp 500 000 kr' })
    expect(readings.lender_name).toEqual({ value: undefined, page: undefined, quote: undefined })
    expect(Object.keys(readingsFromAnswer(def, 'not an object'))).toEqual(def.fields.map((f) => f.name))
  })
})
