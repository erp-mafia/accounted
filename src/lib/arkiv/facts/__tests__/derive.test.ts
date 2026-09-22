import { describe, it, expect } from 'vitest'
import type { ExtractedField, Payload } from '@/lib/documents/extract/fields'
import { deriveFacts } from '../derive'
import { FIELD_PREDICATES, PREDICATES, hasFactPredicates, predicateDef } from '../predicates'
import { SCHEMAS } from '@/lib/documents/extract/schemas'

function payload(fields: Record<string, string | number>, pages: Record<string, number> = {}): Payload {
  const out: Payload = {}
  for (const [name, value] of Object.entries(fields)) out[name] = { value, normalized: value, page: pages[name] ?? 1, quote: `q ${name}`, bbox: null, confidence: 1, method: 'consensus', readings: [] } satisfies ExtractedField
  return out
}

describe('predicates', () => {
  it('map only fields that exist in the schema, to predicates that exist in the vocabulary, on the right subject', () => {
    for (const [schemaType, mapping] of Object.entries(FIELD_PREDICATES)) {
      const fields = new Set(SCHEMAS[schemaType].fields.map((f) => f.name))
      const subject = schemaType.startsWith('agreement.') ? 'agreement' : 'company'
      for (const m of mapping) {
        expect(fields.has(m.field), `${schemaType}.${m.field}`).toBe(true)
        if (m.validFromField) expect(fields.has(m.validFromField), `${schemaType}.${m.validFromField}`).toBe(true)
        expect(PREDICATES[m.predicate]?.subject, `${schemaType}.${m.field} -> ${m.predicate}`).toBe(subject)
      }
    }
    expect(hasFactPredicates('agreement.loan')).toBe(true)
    expect(hasFactPredicates('receipt')).toBe(false)
    expect(predicateDef('vat_period')?.label).toBe('Momsperiod')
  })
})

describe('deriveFacts', () => {
  it('turns a registreringsbevis into company facts, each citing its page', () => {
    const facts = deriveFacts({ schemaType: 'registration.bolagsverket', payload: payload({ company_name: 'Arcim Technology AB', org_number: '5595386219', share_capital: 25000, auditor: 'Ingen revisor' }, { share_capital: 2 }), reviewFields: [] })
    expect(facts.map((f) => f.predicate)).toEqual(['legal_name', 'org_number', 'share_capital', 'auditor'])
    expect(facts[2]).toEqual({ subjectKind: 'company', predicate: 'share_capital', value: 25000, valueText: '25000', singleValued: true, validFrom: null, validTo: null, evidence: { field: 'share_capital', page: 2, quote: 'q share_capital' } })
  })

  it('dates a Skatteverket registration from its own from-date and leaves reviewed fields out', () => {
    const facts = deriveFacts({ schemaType: 'decision.skatteverket', payload: payload({ f_skatt: 'approved', f_skatt_from: '2025-11-07', vat_registered: 'yes', vat_from: '2025-11-07', vat_period: 'helt beskattningsår' }), reviewFields: ['vat_period'] })
    expect(facts.map((f) => [f.predicate, f.validFrom])).toEqual([
      ['f_skatt', '2025-11-07'],
      ['vat_registered', '2025-11-07'],
    ])
  })

  it('turns an agreement record into agreement facts and renames the amount fields', () => {
    const facts = deriveFacts({ schemaType: 'agreement.rental', payload: payload({ landlord_name: 'Kvarnen AB', monthly_rent: 12500, rent_currency: 'SEK', notice_months: 9 }), reviewFields: [] })
    expect(facts.map((f) => [f.subjectKind, f.predicate, f.value])).toEqual([
      ['agreement', 'counterparty_name', 'Kvarnen AB'],
      ['agreement', 'notice_months', 9],
      ['agreement', 'amount', 12500],
      ['agreement', 'currency', 'SEK'],
    ])
  })

  it('asserts nothing for a schema without predicates', () => {
    expect(deriveFacts({ schemaType: 'generic', payload: payload({ total_amount: 5 }), reviewFields: [] })).toEqual([])
  })
})
