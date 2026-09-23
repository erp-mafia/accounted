import { describe, it, expect } from 'vitest'
import { ACTING_FIELDS, actingFields } from '../acting'
import { SCHEMAS } from '../schemas'

describe('acting fields', () => {
  it('names only fields that exist in the schema, and nothing for what Arkiv never asks about', () => {
    for (const [schemaType, names] of Object.entries(ACTING_FIELDS)) {
      const known = new Set(SCHEMAS[schemaType].fields.map((f) => f.name))
      for (const name of names) expect(known.has(name), `${schemaType}.${name}`).toBe(true)
    }
    for (const silent of [
      'receipt',
      'supplier_invoice',
      'credit_note',
      'minutes.board',
      'minutes.agm',
      'share_subscription_list',
      'annual_report',
      'filing.bolagsverket',
      'generic',
    ])
      expect(actingFields(silent).size).toBe(0)
    expect(actingFields('agreement.loan').has('disbursed_on')).toBe(true)
    expect(actingFields('agreement.loan').has('signed_on')).toBe(false)
  })
})
