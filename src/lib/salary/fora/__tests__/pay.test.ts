/**
 * Fora's pay figure (lib/salary/fora/pay.ts): the engine's bruttolön minus
 * the taxable rows Fora's list of lönetyper leaves out.
 */
import { describe, it, expect } from 'vitest'
import { FORA_PAY_TREATMENT, foraPayAmount, type ForaPayLine } from '../pay'
import { PAYSLIP_LINE_ROLES } from '@/lib/salary/line-item-roles'

function line(item_type: string, amount: number, flags: Partial<ForaPayLine> = {}): ForaPayLine {
  return { item_type, amount, is_taxable: true, is_gross_deduction: false, is_net_deduction: false, ...flags }
}

describe('FORA_PAY_TREATMENT', () => {
  it('classifies every payslip row type the engine knows', () => {
    expect(Object.keys(FORA_PAY_TREATMENT).sort()).toEqual(Object.keys(PAYSLIP_LINE_ROLES).sort())
  })

  it('only takes out rows the engine counts into the bruttolön, and keeps out what never is in it', () => {
    for (const [type, treatment] of Object.entries(FORA_PAY_TREATMENT)) {
      const role = PAYSLIP_LINE_ROLES[type as keyof typeof PAYSLIP_LINE_ROLES]
      if (treatment === 'excluded') expect(role, type).toBe('addition')
      if (treatment === 'outside_gross') {
        expect(['benefit', 'reimbursement', 'net_deduction', 'net_rounding', 'text'], type).toContain(role)
      }
      if (treatment === 'counted') {
        expect(['base_salary', 'addition', 'absence', 'gross_deduction'], type).toContain(role)
      }
    }
  })

  it('leaves out taxable traktamente and bilersättning, as Fora lists them', () => {
    expect(FORA_PAY_TREATMENT.traktamente_taxable).toBe('excluded')
    expect(FORA_PAY_TREATMENT.mileage_taxable).toBe('excluded')
    expect(FORA_PAY_TREATMENT.semesterersattning).toBe('counted')
    expect(FORA_PAY_TREATMENT.sick_day2_14).toBe('counted')
    expect(FORA_PAY_TREATMENT.bonus).toBe('counted')
  })
})

describe('foraPayAmount', () => {
  it('is the bruttolön when nothing Fora excludes is on the payslip', () => {
    const lines = [line('monthly_salary', 30000), line('ob_weekend', 1250.5), line('benefit_meals', 900)]
    expect(foraPayAmount(31250.5, lines)).toBe(31250.5)
  })

  it('takes out taxable traktamente and taxable mileage', () => {
    const lines = [line('monthly_salary', 30000), line('traktamente_taxable', 480), line('mileage_taxable', 312.4)]
    expect(foraPayAmount('30792.40', lines)).toBe(30000)
  })

  it('leaves a row the engine did not add: not taxable, or flagged as a deduction', () => {
    const lines = [
      line('traktamente_taxable', 480, { is_taxable: false }),
      line('mileage_taxable', 300, { is_gross_deduction: true }),
      line('mileage_taxable', 200, { is_net_deduction: true }),
    ]
    expect(foraPayAmount(30000, lines)).toBe(30000)
  })

  it('keeps löneväxling deducted: the cash actually paid out', () => {
    // The engine's bruttolön is already after the 2 000 kr bruttolöneavdrag.
    const lines = [line('monthly_salary', 30000), line('gross_deduction_pension', -2000, { is_gross_deduction: true })]
    expect(foraPayAmount(28000, lines)).toBe(28000)
  })

  it('rounds to öre', () => {
    expect(foraPayAmount(0.3, [line('traktamente_taxable', 0.1)])).toBe(0.2)
  })
})
