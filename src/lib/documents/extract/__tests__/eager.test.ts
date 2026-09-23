import { describe, it, expect } from 'vitest'
import { eagerFields, eagerSchema } from '../eager'
import { ACTING_FIELDS } from '../acting'
import { SCHEMAS } from '../schemas'

describe('eager fields', () => {
  it('reads on arrival what names, files, acts or becomes a company fact, and leaves the rest for a question', () => {
    let eager = 0
    let all = 0
    for (const def of Object.values(SCHEMAS)) {
      const names = new Set(def.fields.map((f) => f.name))
      const chosen = eagerFields(def.schemaType)
      for (const name of chosen) expect(names.has(name), `${def.schemaType}.${name}`).toBe(true)
      for (const name of ACTING_FIELDS[def.schemaType] ?? []) expect(chosen.has(name)).toBe(true)
      eager += chosen.size
      all += def.fields.length
    }
    expect(all).toBeGreaterThan(200)
    // Agreements are mostly acting fields; the trim lands on receipts, invoices, minutes and descriptive clauses.
    expect(eager).toBeLessThan(all * 0.8)
    expect(eagerFields('agreement.loan').has('conversion_terms')).toBe(false)
    expect(eagerFields('agreement.loan').has('principal')).toBe(true)
    expect(eagerFields('registration.bolagsverket').has('board_members')).toBe(true)
    expect(eagerFields('receipt')).toEqual(new Set(['merchant_name', 'receipt_date', 'total_amount', 'currency']))
  })

  it('keeps the schema identity and only trims the field list', () => {
    const loan = eagerSchema(SCHEMAS['agreement.loan'])
    expect(loan.schemaType).toBe('agreement.loan')
    expect(loan.version).toBe(SCHEMAS['agreement.loan'].version)
    expect(loan.fields.length).toBeLessThan(SCHEMAS['agreement.loan'].fields.length)
    expect(loan.fields.some((f) => f.required)).toBe(true)
  })
})
