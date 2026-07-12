import { describe, it, expect } from 'vitest'
import {
  ROT_PERCENT,
  RUT_PERCENT,
  ROT_MAX,
  RUT_MAX,
  computeDeduction,
  computeInvoiceDeductionTotal,
  computeDeductionTotalsByKind,
  validateInvoice,
  type ItemForDeduction,
  type ValidateInvoiceItem,
} from '../rot-rut-rules'

describe('rot-rut-rules: constants', () => {
  it('uses the 2026 statutory rates', () => {
    expect(ROT_PERCENT).toBe(0.30)
    expect(RUT_PERCENT).toBe(0.50)
    expect(ROT_MAX).toBe(50000)
    expect(RUT_MAX).toBe(75000)
  })
})

describe('computeDeduction', () => {
  it('standard ROT: 10 000 kr labor → 3 000 kr deduction', () => {
    const item: ItemForDeduction = {
      unit_price: 10000,
      quantity: 1,
      deduction_type: 'rot',
    }
    expect(computeDeduction(item)).toBe(3000)
  })

  it('standard RUT: 5 000 kr labor → 2 500 kr deduction', () => {
    const item: ItemForDeduction = {
      unit_price: 5000,
      quantity: 1,
      deduction_type: 'rut',
    }
    expect(computeDeduction(item)).toBe(2500)
  })

  it('no deduction_type → 0', () => {
    const item: ItemForDeduction = {
      unit_price: 10000,
      quantity: 1,
    }
    expect(computeDeduction(item)).toBe(0)
  })

  it('null deduction_type → 0', () => {
    const item: ItemForDeduction = {
      unit_price: 10000,
      quantity: 1,
      deduction_type: null,
    }
    expect(computeDeduction(item)).toBe(0)
  })

  it('negative or zero amount → 0', () => {
    expect(computeDeduction({ unit_price: 0, quantity: 1, deduction_type: 'rot' })).toBe(0)
    expect(computeDeduction({ unit_price: -100, quantity: 1, deduction_type: 'rut' })).toBe(0)
  })

  it('quantity > 1 with ROT', () => {
    const item: ItemForDeduction = {
      unit_price: 500,
      quantity: 20, // 10 000 total
      deduction_type: 'rot',
    }
    expect(computeDeduction(item)).toBe(3000)
  })

  it('rounds to two decimals', () => {
    const item: ItemForDeduction = {
      unit_price: 333.33,
      quantity: 1,
      deduction_type: 'rut', // 333.33 * 0.5 = 166.665 → 166.67 (banker's rounding off)
    }
    expect(computeDeduction(item)).toBe(166.67)
  })

  it('caps at line total even if percent goes off (defensive)', () => {
    // The percent is < 1.0 so this is hypothetical, but the cap is part
    // of the contract: assert it via a synthetic case where unit_price ×
    // quantity happens to be tiny but the rounding step could overshoot.
    const item: ItemForDeduction = {
      unit_price: 0.01,
      quantity: 1,
      deduction_type: 'rut',
    }
    // 0.01 * 0.5 = 0.005 → rounds to 0.01 = line_total. OK, capped.
    expect(computeDeduction(item)).toBe(0.01)
  })
})

describe('computeInvoiceDeductionTotal', () => {
  it('mixed: ROT line + non-eligible line: only ROT generates deduction', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' },
      { unit_price: 2000, quantity: 1 }, // not flagged
    ]
    expect(computeInvoiceDeductionTotal(items)).toBe(3000)
  })

  it('mixed ROT + RUT lines sum independently', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' }, // 3 000
      { unit_price: 4000, quantity: 1, deduction_type: 'rut' }, // 2 000
    ]
    expect(computeInvoiceDeductionTotal(items)).toBe(5000)
  })

  it('all non-eligible → 0', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 1000, quantity: 1 },
      { unit_price: 2000, quantity: 1 },
    ]
    expect(computeInvoiceDeductionTotal(items)).toBe(0)
  })
})

describe('computeDeductionTotalsByKind', () => {
  it('separates ROT and RUT', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' }, // 3 000
      { unit_price: 4000, quantity: 1, deduction_type: 'rut' }, // 2 000
      { unit_price: 2000, quantity: 1, deduction_type: 'rot' }, // 600
    ]
    expect(computeDeductionTotalsByKind(items)).toEqual({ rot: 3600, rut: 2000 })
  })
})

describe('validateInvoice', () => {
  it('errors when ROT/RUT but personnummer missing', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1, deduction_type: 'rut' },
    ]
    const result = validateInvoice(items, false, true)
    expect(result.errors).toContain('Personnummer krävs för ROT/RUT-avdrag.')
  })

  it('errors when ROT but housing_designation missing', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1, deduction_type: 'rot' },
    ]
    const result = validateInvoice(items, true, false)
    expect(result.errors).toContain('Fastighetsbeteckning krävs för ROT-avdrag.')
  })

  it('RUT without housing_designation → no error (RUT does not require it)', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1, deduction_type: 'rut' },
    ]
    const result = validateInvoice(items, true, false)
    expect(result.errors).toHaveLength(0)
  })

  it('no deduction lines → no errors regardless of metadata', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1 },
    ]
    expect(validateInvoice(items, false, false).errors).toHaveLength(0)
  })

  it('warns about ROT cap when invoice alone exceeds 50 000', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 200000, quantity: 1, deduction_type: 'rot' }, // 60 000 deduction
    ]
    const result = validateInvoice(items, true, true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toMatch(/ROT/)
    expect(result.warnings[0]).toMatch(/50/)
  })

  it('warns about RUT cap when invoice alone exceeds 75 000', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 200000, quantity: 1, deduction_type: 'rut' }, // 100 000 deduction
    ]
    const result = validateInvoice(items, true, true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toMatch(/RUT/)
    expect(result.warnings[0]).toMatch(/75/)
  })

  it('no warning when total under cap', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' }, // 3 000: well under cap
    ]
    const result = validateInvoice(items, true, true)
    expect(result.warnings).toHaveLength(0)
  })
})
