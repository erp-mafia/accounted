import { describe, it, expect } from 'vitest'
import {
  RECURRING_LINE_ITEM_TYPES,
  RECURRING_LINE_AMOUNT_SIGN_MESSAGE,
  recurringLineFlags,
  validateRecurringLineAmount,
} from '../recurring-lines'

describe('recurringLineFlags', () => {
  it('marks gross deductions as taxable, avgift-basis gross deductions', () => {
    for (const t of ['gross_deduction_pension', 'gross_deduction_other'] as const) {
      expect(recurringLineFlags(t)).toEqual({
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: false,
        is_gross_deduction: true,
        is_net_deduction: false,
      })
    }
  })

  it('marks net deductions as after-tax only', () => {
    for (const t of [
      'net_deduction_union',
      'net_deduction_benefit_payment',
      'net_deduction_other',
    ] as const) {
      expect(recurringLineFlags(t)).toEqual({
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: true,
      })
    }
  })

  it('every supported type is a deduction with exactly one deduction flag set', () => {
    // 'other' (recurring addition) is deliberately absent: the engine does
    // not treat generic taxable rows as additions, see recurring-lines.ts.
    expect(RECURRING_LINE_ITEM_TYPES).not.toContain('other')
    for (const t of RECURRING_LINE_ITEM_TYPES) {
      const flags = recurringLineFlags(t)
      expect(flags.is_gross_deduction && flags.is_net_deduction).toBe(false)
      expect(flags.is_gross_deduction || flags.is_net_deduction).toBe(true)
    }
  })
})

describe('validateRecurringLineAmount', () => {
  it('requires deductions to be negative', () => {
    expect(validateRecurringLineAmount('gross_deduction_other', -670.17)).toBeNull()
    expect(validateRecurringLineAmount('gross_deduction_other', 670.17)).toBe(
      RECURRING_LINE_AMOUNT_SIGN_MESSAGE,
    )
    expect(validateRecurringLineAmount('net_deduction_union', -100)).toBeNull()
    expect(validateRecurringLineAmount('net_deduction_union', 100)).toBe(
      RECURRING_LINE_AMOUNT_SIGN_MESSAGE,
    )
  })

  it('never accepts zero, positive or non-finite amounts', () => {
    expect(validateRecurringLineAmount('gross_deduction_other', 0)).toBe(
      RECURRING_LINE_AMOUNT_SIGN_MESSAGE,
    )
    expect(validateRecurringLineAmount('net_deduction_other', Number.NaN)).toBe(
      RECURRING_LINE_AMOUNT_SIGN_MESSAGE,
    )
    expect(validateRecurringLineAmount('gross_deduction_pension', Number.POSITIVE_INFINITY)).toBe(
      RECURRING_LINE_AMOUNT_SIGN_MESSAGE,
    )
  })
})
