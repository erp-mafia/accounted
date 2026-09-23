import { describe, it, expect } from 'vitest'
import { mergeReadings, runChecks } from '../merge'
import { SCHEMAS } from '../schemas'

const loan = SCHEMAS['agreement.loan']
const LENDER = { lender_name: { value: 'Almi Företagspartner AB' }, principal: { value: 1_000_000 } }

/** A model reading with every loan field null except the given ones. */
function reading(fields: Record<string, { value: unknown; page?: number; quote?: string }>): Record<string, unknown> {
  return Object.fromEntries(loan.fields.map((f) => [f.name, { page: null, quote: null, ...(fields[f.name] ?? { value: null }) }]))
}

describe('mergeReadings', () => {
  it('settles agreeing readings with full confidence and cites reading A', () => {
    const a = reading({ lender_name: { value: 'Almi AB', page: 1, quote: 'Långivare: Almi AB' }, principal: { value: '1 000 000 kr', page: 1 } })
    const b = reading({ lender_name: { value: 'ALMI AB' }, principal: { value: 1_000_000, page: 2 } })
    const out = mergeReadings(loan, a, b)
    expect(out.payload.lender_name).toMatchObject({ value: 'Almi AB', normalized: 'Almi AB', page: 1, quote: 'Långivare: Almi AB', confidence: 1, method: 'consensus' })
    expect(out.payload.principal).toMatchObject({ normalized: 1_000_000, confidence: 1 })
    expect(out.checks).toEqual([])
    expect(out.reviewFields).toEqual([])
  })

  it('sends a field the readings disagree on to review, and only that field', () => {
    const out = mergeReadings(loan, reading({ ...LENDER, interest_rate: { value: 11.1, page: 3 } }), reading({ ...LENDER, interest_rate: { value: 11.03, page: 3 } }))
    expect(out.reviewFields).toEqual(['interest_rate'])
    expect(out.payload.interest_rate).toMatchObject({ value: 11.1, confidence: 0.3, method: 'single_reading' })
    expect(out.payload.interest_rate.readings.map((r) => r.value)).toEqual([11.1, 11.03])
    expect(out.payload.lender_name.confidence).toBe(1)
  })

  it('settles descriptive text when both readings found it, citing the careful reading', () => {
    const out = mergeReadings(
      loan,
      reading({ ...LENDER, security: { value: 'Företagsinteckning 500 000 kr', page: 2 } }),
      reading({ ...LENDER, security: { value: 'Företagsinteckning om 500 000 kronor' } }),
    )
    expect(out.payload.security).toMatchObject({ value: 'Företagsinteckning 500 000 kr', page: 2, confidence: 1, method: 'consensus' })
    expect(out.reviewFields).toEqual([])
  })

  it('keeps a value only one reading found, cites that reading, and asks a person', () => {
    const out = mergeReadings(loan, reading(LENDER), reading({ ...LENDER, maturity_on: { value: '2029-06-30', page: 2, quote: 'återbetalas senast 2029-06-30' } }))
    expect(out.payload.maturity_on).toMatchObject({ value: '2029-06-30', normalized: '2029-06-30', page: 2, confidence: 0.5, method: 'single_reading' })
    expect(out.reviewFields).toEqual(['maturity_on'])
  })

  it('asks a person about a value that does not parse instead of dropping it', () => {
    const out = mergeReadings(loan, reading({ ...LENDER, maturity_on: { value: 'mars 2029' } }), reading(LENDER))
    expect(out.payload.maturity_on).toMatchObject({ value: 'mars 2029', normalized: null, confidence: 0.4 })
    expect(out.reviewFields).toEqual(['maturity_on'])
  })

  it('treats a placeholder written where the schema says null as no reading, so nobody is asked to confirm it', () => {
    for (const placeholder of ['Not printed in document', 'not stated', 'N/A', 'Framgår ej av dokumentet', 'saknas', '-']) {
      const out = mergeReadings(loan, reading({ ...LENDER, lender_org_number: { value: placeholder } }), reading(LENDER))
      expect(out.payload.lender_org_number, placeholder).toMatchObject({ value: null, normalized: null })
      expect(out.reviewFields, placeholder).toEqual([])
    }
  })

  it('fails the required check when both readings miss a required field', () => {
    const lenderOnly = reading({ lender_name: LENDER.lender_name })
    const out = mergeReadings(loan, lenderOnly, lenderOnly)
    expect(out.checks).toEqual([{ check: 'required', field: 'principal' }])
    expect(out.reviewFields).toEqual(['principal'])
  })

  it('does not let agreement excuse an invalid organisation number or reversed dates', () => {
    const both = reading({ ...LENDER, lender_org_number: { value: '556016-7452' }, disbursed_on: { value: '2026-05-01' }, maturity_on: { value: '2025-05-01' } })
    const out = mergeReadings(loan, both, both)
    expect(out.checks).toEqual([
      { check: 'orgnr_luhn', field: 'lender_org_number' },
      { check: 'date_order', field: 'maturity_on' },
    ])
    expect(out.reviewFields).toEqual(['lender_org_number', 'maturity_on'])
  })
})

describe('runChecks', () => {
  it('flags negative amounts and percentages outside 0 to 100', () => {
    const both = reading({ lender_name: LENDER.lender_name, principal: { value: -5 }, interest_rate: { value: 140 } })
    expect(runChecks(loan, mergeReadings(loan, both, both).payload)).toEqual([
      { check: 'non_negative', field: 'principal' },
      { check: 'percent_range', field: 'interest_rate' },
    ])
  })
})
