/**
 * The VAT-registration seam every bank-transaction mapping builder resolves
 * its treatment through. Only an explicit `false` changes anything: a
 * rate-bearing treatment becomes exempt, everything else passes through, so
 * a registered company (or a caller that never loaded the flag) books
 * exactly as before.
 */
import { describe, it, expect } from 'vitest'
import {
  NO_VAT_TREATMENT,
  isNotVatRegistered,
  vatTreatmentForRegistration,
} from '../vat-registration'

describe('vatTreatmentForRegistration', () => {
  it('leaves every treatment untouched for true, null and undefined', () => {
    for (const flag of [true, null, undefined]) {
      for (const treatment of ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt', null, undefined] as const) {
        expect(vatTreatmentForRegistration(treatment, flag)).toBe(treatment)
      }
    }
  })

  it('resolves a rate-bearing treatment to exempt for an explicit false', () => {
    expect(NO_VAT_TREATMENT).toBe('exempt')
    expect(vatTreatmentForRegistration('standard_25', false)).toBe('exempt')
    expect(vatTreatmentForRegistration('reduced_12', false)).toBe('exempt')
    expect(vatTreatmentForRegistration('reduced_6', false)).toBe('exempt')
  })

  it('keeps reverse charge, export, exempt and no treatment for an explicit false', () => {
    expect(vatTreatmentForRegistration('reverse_charge', false)).toBe('reverse_charge')
    expect(vatTreatmentForRegistration('export', false)).toBe('export')
    expect(vatTreatmentForRegistration('exempt', false)).toBe('exempt')
    expect(vatTreatmentForRegistration(null, false)).toBeNull()
    expect(vatTreatmentForRegistration(undefined, false)).toBeUndefined()
  })

  it('isNotVatRegistered is true only for an explicit false', () => {
    expect(isNotVatRegistered(false)).toBe(true)
    expect(isNotVatRegistered(true)).toBe(false)
    expect(isNotVatRegistered(null)).toBe(false)
    expect(isNotVatRegistered(undefined)).toBe(false)
  })
})
