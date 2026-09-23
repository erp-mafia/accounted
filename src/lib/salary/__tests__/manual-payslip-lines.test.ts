import { describe, expect, it } from 'vitest'
import { TAX_FREE_REIMBURSEMENT_TYPES } from '@/lib/salary/account-mapping'
import {
  MANUAL_PAYSLIP_LINE_SPECS,
  MANUAL_PAYSLIP_LINE_TYPES,
  buildManualPayslipLine,
  isManualPayslipLineType,
  manualLineCapsFromRunParams,
  type ManualLineBody,
} from '@/lib/salary/manual-payslip-lines'
import { SalaryLineItemTypeSchema } from '@/lib/api/schemas'

const body = (r: ReturnType<typeof buildManualPayslipLine>): ManualLineBody => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`)
  return r.body
}

describe('manual payslip line catalogue', () => {
  it('offers only types the line schema accepts, and never a derived or claim-linked one', () => {
    for (const type of MANUAL_PAYSLIP_LINE_TYPES) {
      expect(SalaryLineItemTypeSchema.safeParse(type).success, type).toBe(true)
    }
    for (const derived of [
      'monthly_salary', 'hourly_salary', 'sick_karens', 'sick_day2_14', 'sick_day15_plus',
      'vab', 'parental_leave', 'vacation', 'semesterersattning', 'oresavrundning',
      'expense_reimbursement', 'benefit_car', 'net_deduction_benefit_payment',
    ]) {
      expect(isManualPayslipLineType(derived), derived).toBe(false)
    }
  })

  it('tax-free reimbursements carry no gross flag at all: the engine pays them by type into net', () => {
    for (const type of ['mileage_taxfree', 'traktamente_taxfree'] as const) {
      expect(TAX_FREE_REIMBURSEMENT_TYPES).toContain(type)
      expect(MANUAL_PAYSLIP_LINE_SPECS[type].flags).toEqual({
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
      })
    }
  })

  it('the taxable excess of a reimbursement is taxed and avgift basis but not semestergrundande', () => {
    for (const type of ['mileage_taxable', 'traktamente_taxable'] as const) {
      const f = MANUAL_PAYSLIP_LINE_SPECS[type].flags
      expect(f.is_taxable).toBe(true)
      expect(f.is_avgift_basis).toBe(true)
      expect(f.is_vacation_basis).toBe(false)
    }
  })

  it('wages (incl. variable pay: övertid, OB, bonus) are taxed, avgift basis and semestergrundande', () => {
    // Semesterlagen: rörliga lönedelar earn semesterlön under both rules
    // (12 % on the variable part under sammalöneregeln, part of the base
    // under procentregeln), see the swedish-payroll vacation-pay reference.
    for (const type of ['bonus', 'commission', 'overtime', 'overtime_50', 'ob_night', 'ob_holiday', 'other'] as const) {
      expect(MANUAL_PAYSLIP_LINE_SPECS[type].flags).toEqual({
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: false,
        is_net_deduction: false,
      })
    }
  })

  it('deductions are flagged the way the recurring lines are', () => {
    expect(MANUAL_PAYSLIP_LINE_SPECS.gross_deduction_other.flags).toEqual({
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: true,
      is_net_deduction: false,
    })
    for (const type of ['net_deduction_advance', 'net_deduction_other'] as const) {
      expect(MANUAL_PAYSLIP_LINE_SPECS[type].flags.is_net_deduction).toBe(true)
      expect(MANUAL_PAYSLIP_LINE_SPECS[type].flags.is_taxable).toBe(false)
    }
  })
})

describe('buildManualPayslipLine', () => {
  it('milersättning: quantity x unit price, tax-free, Swedish default description', () => {
    expect(body(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 12.5, unit_price: 25 }))).toEqual({
      item_type: 'mileage_taxfree',
      description: 'Milersättning (skattefri)',
      quantity: 12.5,
      unit_price: 25,
      amount: 312.5,
      is_taxable: false,
      is_avgift_basis: false,
      is_vacation_basis: false,
      is_gross_deduction: false,
      is_net_deduction: false,
    })
  })

  it('traktamente: three days at the 2026 schablon', () => {
    const b = body(buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 3, unit_price: 300 }))
    expect(b.amount).toBe(900)
    expect(b.is_taxable).toBe(false)
  })

  it('quantity x unit price wins over a typed amount, and rounds to öre', () => {
    const b = body(buildManualPayslipLine({ item_type: 'overtime', quantity: 3, unit_price: 233.333, amount: 1 }))
    expect(b.amount).toBe(700)
  })

  it('a deduction is stored negative whatever sign was typed; an addition positive', () => {
    expect(body(buildManualPayslipLine({ item_type: 'net_deduction_advance', amount: 2000 })).amount).toBe(-2000)
    expect(body(buildManualPayslipLine({ item_type: 'net_deduction_advance', amount: -2000 })).amount).toBe(-2000)
    expect(body(buildManualPayslipLine({ item_type: 'bonus', amount: -5000 })).amount).toBe(5000)
  })

  it('a correction keeps the typed sign', () => {
    expect(body(buildManualPayslipLine({ item_type: 'correction', amount: -150 })).amount).toBe(-150)
    expect(body(buildManualPayslipLine({ item_type: 'correction', amount: 150 })).amount).toBe(150)
  })

  it('keeps a typed description and falls back to the label when blank', () => {
    expect(body(buildManualPayslipLine({ item_type: 'bonus', amount: 1, description: '  Q3  ' })).description).toBe('Q3')
    expect(body(buildManualPayslipLine({ item_type: 'bonus', amount: 1, description: '   ' })).description).toBe('Bonus')
  })

  it('refuses a missing amount, zero, or an unknown type', () => {
    for (const input of [
      { item_type: 'bonus' as const },
      { item_type: 'bonus' as const, amount: 0 },
      { item_type: 'bonus' as const, quantity: 0, unit_price: 25 },
      { item_type: 'bonus' as const, amount: Number.NaN },
      { item_type: 'monthly_salary' as never, amount: 1 },
    ]) {
      expect(buildManualPayslipLine(input)).toEqual({ ok: false, reason: 'no_amount' })
    }
  })

  it('omits quantity and unit price from the body when only one is given', () => {
    const b = body(buildManualPayslipLine({ item_type: 'overtime', quantity: 4, amount: 1000 }))
    expect(b.amount).toBe(1000)
    expect(b.quantity).toBe(4)
    expect('unit_price' in b).toBe(false)
  })

  describe('tax-free schablon caps (from the run year payroll config)', () => {
    const caps = { mileage_taxfree: 25, traktamente_taxfree: 300 }

    it('refuses a tax-free milersättning priced above the schablon', () => {
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 30 }, caps)).toEqual({
        ok: false,
        reason: 'above_tax_free_cap',
        cap: 25,
        unit: 'mil',
      })
      // Amount over quantity is a price too.
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, amount: 300 }, caps)).toMatchObject({
        ok: false,
        reason: 'above_tax_free_cap',
      })
    })

    it('accepts the schablon itself, below it, and a half day', () => {
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 25 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 18.5 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 2, unit_price: 150 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 1, unit_price: 300.001 }, caps).ok).toBe(false)
    })

    it('does not judge an amount without a quantity, the taxable rows, or a run without caps', () => {
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', amount: 5000 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxable', quantity: 10, unit_price: 30 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 30 }).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 30 }, { mileage_taxfree: 0 }).ok).toBe(true)
    })
  })
})

describe('manualLineCapsFromRunParams', () => {
  it('reads the serialized payroll config in either casing, ignores junk, empty without params', () => {
    expect(manualLineCapsFromRunParams({ milersattning_egen_bil: 25, traktamente_heldag: 300 })).toEqual({
      mileage_taxfree: 25,
      traktamente_taxfree: 300,
    })
    expect(manualLineCapsFromRunParams({ milersattningEgenBil: 25, traktamenteHeldag: 290 })).toEqual({
      mileage_taxfree: 25,
      traktamente_taxfree: 290,
    })
    expect(manualLineCapsFromRunParams({ milersattning_egen_bil: '25', traktamente_heldag: -1 })).toEqual({})
    expect(manualLineCapsFromRunParams(null)).toEqual({})
    expect(manualLineCapsFromRunParams(undefined)).toEqual({})
  })
})
