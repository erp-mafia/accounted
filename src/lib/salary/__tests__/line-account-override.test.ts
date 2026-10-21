import { describe, expect, it } from 'vitest'
import { isAllowedOverrideAccount, lineAccountOverride } from '../line-account-override'
import { MANUAL_PAYSLIP_LINE_TYPES } from '../manual-payslip-lines'
import { RECURRING_LINE_ITEM_TYPES } from '../recurring-lines'

describe('lineAccountOverride', () => {
  it('offers no override on rows that never post on their own account', () => {
    for (const type of [
      'benefit_car',
      'benefit_wellness',
      'sick_karens',
      'sick_day2_14',
      'vab',
      'parental_leave',
      'unpaid_leave',
      'vacation',
      'overtime_50',
      'ob_night',
      'gross_deduction_pension',
      'gross_deduction_other',
      'expense_reimbursement',
      'oresavrundning',
      'text',
    ]) {
      expect(lineAccountOverride(type), type).toBe('none')
    }
  })

  it('limits pay rows to class 7 and lets net deductions name any account', () => {
    for (const type of ['bonus', 'commission', 'overtime', 'other', 'correction', 'mileage_taxfree', 'traktamente_taxable']) {
      expect(lineAccountOverride(type), type).toBe('class_7')
    }
    for (const type of ['net_deduction_union', 'net_deduction_advance', 'net_deduction_benefit_payment', 'net_deduction_other']) {
      expect(lineAccountOverride(type), type).toBe('any')
    }
  })

  it('gives every manual payslip type except the gross deduction, kostförmån and the text row a picker', () => {
    const withPicker = MANUAL_PAYSLIP_LINE_TYPES.filter((type) => lineAccountOverride(type) !== 'none')
    expect(withPicker).toEqual(
      MANUAL_PAYSLIP_LINE_TYPES.filter(
        (type) => type !== 'gross_deduction_other' && type !== 'benefit_meals' && type !== 'text',
      ),
    )
  })

  it('gives only the recurring net deductions a picker', () => {
    const withPicker = RECURRING_LINE_ITEM_TYPES.filter((type) => lineAccountOverride(type) !== 'none')
    expect(withPicker).toEqual(['net_deduction_union', 'net_deduction_benefit_payment', 'net_deduction_other'])
  })
})

describe('isAllowedOverrideAccount', () => {
  it('refuses a pay row outside class 7', () => {
    expect(isAllowedOverrideAccount('bonus', '7010')).toBe(true)
    expect(isAllowedOverrideAccount('bonus', '1930')).toBe(false)
    expect(isAllowedOverrideAccount('bonus', '2799')).toBe(false)
  })

  it('lets a net deduction credit any account', () => {
    expect(isAllowedOverrideAccount('net_deduction_benefit_payment', '7381')).toBe(true)
    expect(isAllowedOverrideAccount('net_deduction_union', '2794')).toBe(true)
  })

  it('refuses partial numbers and rows without an override', () => {
    expect(isAllowedOverrideAccount('bonus', '70')).toBe(false)
    expect(isAllowedOverrideAccount('benefit_car', '7385')).toBe(false)
  })
})
