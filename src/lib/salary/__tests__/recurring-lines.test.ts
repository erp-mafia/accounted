import { describe, it, expect } from 'vitest'
import {
  RECURRING_LINE_ITEM_TYPES,
  RECURRING_LINE_AMOUNT_SIGN_MESSAGE,
  RECURRING_LINE_LABELS,
  validateRecurringLineAmount,
} from '../recurring-lines'
import { payslipLineFlags } from '../line-item-roles'
import { RecurringLineItemTypeSchema } from '@/lib/api/schemas'
import { TEXT_ROW_AMOUNT_MESSAGE } from '@/lib/salary/text-rows'

describe('the flags of a recurring line', () => {
  it('marks gross deductions as taxable, avgift-basis gross deductions', () => {
    for (const t of ['gross_deduction_pension', 'gross_deduction_other'] as const) {
      expect(payslipLineFlags(t)).toEqual({
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
      expect(payslipLineFlags(t)).toEqual({
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: true,
      })
    }
  })

  it('every money type is a deduction with exactly one deduction flag set', () => {
    // 'other' (recurring addition) is deliberately absent: proration,
    // absence, sjuklön and the OB rate read only monthly_salary, see
    // recurring-lines.ts.
    expect(RECURRING_LINE_ITEM_TYPES).not.toContain('other')
    for (const t of RECURRING_LINE_ITEM_TYPES.filter((type) => type !== 'text')) {
      const flags = payslipLineFlags(t)
      expect(flags.is_gross_deduction && flags.is_net_deduction).toBe(false)
      expect(flags.is_gross_deduction || flags.is_net_deduction).toBe(true)
    }
  })

  it('a text row carries no flag at all', () => {
    expect(payslipLineFlags('text')).toEqual({
      is_taxable: false,
      is_avgift_basis: false,
      is_vacation_basis: false,
      is_gross_deduction: false,
      is_net_deduction: false,
    })
  })

  it('the Zod enum and the labels are derived from the one type list', () => {
    expect(RecurringLineItemTypeSchema.options).toEqual([...RECURRING_LINE_ITEM_TYPES])
    expect(Object.keys(RECURRING_LINE_LABELS).sort()).toEqual(
      RECURRING_LINE_ITEM_TYPES.filter((type) => type !== 'text').sort(),
    )
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

describe('validateRecurringLineAmount on a text row', () => {
  it('accepts no amount or 0, refuses any other amount', () => {
    expect(validateRecurringLineAmount('text', undefined)).toBeNull()
    expect(validateRecurringLineAmount('text', 0)).toBeNull()
    expect(validateRecurringLineAmount('text', -100)).toBe(TEXT_ROW_AMOUNT_MESSAGE)
    expect(validateRecurringLineAmount('text', 100)).toBe(TEXT_ROW_AMOUNT_MESSAGE)
  })

  it('a deduction still needs an amount', () => {
    expect(validateRecurringLineAmount('net_deduction_union', undefined)).toBe(RECURRING_LINE_AMOUNT_SIGN_MESSAGE)
  })
})
