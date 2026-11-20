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
  foldSellerVatIntoCost,
  isNotVatRegistered,
  sellerVatAsCostNote,
  sellerVatIsCost,
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

// The supplier-invoice half (feedback seq 708521): an ideell förening that is
// not VAT-registered got 2000 + 500 with the 500 on 2641. The seller's moms
// is cost for such a company and stays in the payable.
describe('sellerVatIsCost', () => {
  it('holds for an explicit false outside reverse charge only', () => {
    expect(sellerVatIsCost(false, false)).toBe(true)
    expect(sellerVatIsCost(false, true)).toBe(false)
    for (const flag of [true, null, undefined]) {
      expect(sellerVatIsCost(flag, false)).toBe(false)
      expect(sellerVatIsCost(flag, true)).toBe(false)
    }
  })
})

describe('foldSellerVatIntoCost', () => {
  const line = { line_number: 1, account_number: '5010', quantity: 1, unit_price: 2000, line_total: 2000, vat_rate: 0.25, vat_amount: 500 }

  it('moves the seller VAT onto the cost line: 2000 + 500 becomes 2500 at 0 %', () => {
    const { lines, sellerVat } = foldSellerVatIntoCost([line])
    expect(lines).toEqual([{ ...line, unit_price: 2500, line_total: 2500, vat_rate: 0, vat_amount: 0 }])
    expect(sellerVat).toBe(500)
  })

  it('scales the unit price with the line so quantity x price still makes the total', () => {
    const { lines } = foldSellerVatIntoCost([{ ...line, quantity: 10, unit_price: 100, line_total: 1000, vat_amount: 250 }])
    expect(lines[0]).toMatchObject({ quantity: 10, unit_price: 125, line_total: 1250, vat_rate: 0, vat_amount: 0 })
  })

  it('keeps a line without VAT as it is and sums the moved VAT per line to the öre', () => {
    const free = { ...line, account_number: '5710', unit_price: 343, line_total: 343, vat_rate: 0, vat_amount: 0 }
    const reduced = { ...line, unit_price: 100.1, line_total: 100.1, vat_rate: 0.12, vat_amount: 12.01 }
    const { lines, sellerVat } = foldSellerVatIntoCost([free, reduced])
    expect(lines[0]).toBe(free)
    expect(lines[1]).toMatchObject({ line_total: 112.11, unit_price: 112.11, vat_rate: 0, vat_amount: 0 })
    expect(sellerVat).toBe(12.01)
  })

  it('folds a discount row the same way, so the payable keeps its sign', () => {
    const { lines } = foldSellerVatIntoCost([{ ...line, unit_price: -100, line_total: -100, vat_amount: -25 }])
    expect(lines[0]).toMatchObject({ unit_price: -125, line_total: -125, vat_rate: 0, vat_amount: 0 })
  })
})

describe('sellerVatAsCostNote', () => {
  it('names the registration, the moved VAT and the payable on 2440', () => {
    const note = sellerVatAsCostNote(500, 2500)
    expect(note).toMatch(/not VAT-registered/)
    expect(note).toContain("the seller's VAT 500 is added to the cost lines")
    expect(note).toContain('nothing is booked on 2641')
    expect(note).toContain('2440 is credited with 2500')
  })

  it('says the lines carry no seller VAT when nothing moved', () => {
    expect(sellerVatAsCostNote(0, 2500)).toContain('the lines carry no seller VAT')
  })
})
