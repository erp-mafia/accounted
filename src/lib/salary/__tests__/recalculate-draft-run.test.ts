import { describe, it, expect } from 'vitest'
import {
  ACKNOWLEDGE_FLAG,
  applyRefusal,
  describeRow,
  inspectStoredPayslip,
  recalculationRefusal,
  type StoredPayslipRow,
} from '../recalculate-draft-run'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const run = (status: string, companyId = COMPANY) => ({ id: 'run-1', company_id: companyId, status })

describe('recalculationRefusal: the support script recalculates draft runs only', () => {
  it('allows a draft run of the named company', () => {
    expect(recalculationRefusal(run('draft'), COMPANY)).toBeNull()
  })

  it.each(['review', 'approved', 'paid', 'booked', 'corrected'])('refuses a %s run', (status) => {
    const refusal = recalculationRefusal(run(status), COMPANY)
    expect(refusal).toContain(`status "${status}"`)
    expect(refusal).toContain('Only a draft run')
  })

  it('refuses a run that does not exist', () => {
    expect(recalculationRefusal(null, COMPANY)).toBe('No such salary run.')
  })

  it('refuses a draft run of another company: --company is a check, not a hint', () => {
    expect(recalculationRefusal(run('draft', 'other-company'), COMPANY)).toContain('does not belong')
  })
})

describe('inspectStoredPayslip: what support sees before --apply', () => {
  // The shape measured on prod 2026-09-21 (amounts only).
  const salary: StoredPayslipRow = { item_type: 'monthly_salary', description: 'Grundlön', amount: 48000 }
  const car: StoredPayslipRow = { item_type: 'benefit_car', description: 'Bilförmån', amount: 6664, source_benefit_id: 'b-1' }
  const payment: StoredPayslipRow = {
    item_type: 'net_deduction_benefit_payment',
    description: 'Nettolöneavdrag bil',
    amount: -6664,
    source_recurring_line_id: 'r-1',
  }
  const workaround: StoredPayslipRow = {
    item_type: 'gross_deduction_other',
    description: 'Bilförmån justering vid nettolöneavdrag',
    amount: -6664,
    is_gross_deduction: true,
    source_recurring_line_id: 'r-2',
  }

  it('flags the workaround row in the exact prod shape', () => {
    const inspection = inspectStoredPayslip([salary, car, payment, workaround])
    expect(inspection.grossDeductions).toEqual([workaround])
    expect(inspection.flagged).toEqual([workaround])
    expect(inspection.resolutionError).toBeNull()
  })

  it('lists a bruttolöneavdrag of another amount without flagging it', () => {
    const pension: StoredPayslipRow = { item_type: 'gross_deduction_pension', description: 'Löneväxling', amount: -5000 }
    const inspection = inspectStoredPayslip([salary, car, payment, pension])
    expect(inspection.grossDeductions).toEqual([pension])
    expect(inspection.flagged).toEqual([])
  })

  it('flags nothing without a benefit payment', () => {
    expect(inspectStoredPayslip([salary, car, workaround]).flagged).toEqual([])
  })

  it('flags nothing on a payslip with no gross deduction', () => {
    const inspection = inspectStoredPayslip([salary, car, payment])
    expect(inspection.grossDeductions).toEqual([])
    expect(inspection.flagged).toEqual([])
  })

  it('reports a payslip the calculation will refuse (payment next to several benefit types)', () => {
    const meals: StoredPayslipRow = { item_type: 'benefit_meals', description: 'Kost', amount: 2480 }
    const inspection = inspectStoredPayslip([salary, car, meals, payment])
    expect(inspection.resolutionError).toContain('flera förmånstyper')
    expect(inspection.flagged).toEqual([])
  })
})

describe('applyRefusal: --apply never recalculates a flagged run blindly', () => {
  it('passes when nothing is flagged', () => {
    expect(applyRefusal(0, false)).toBeNull()
  })

  it('stops on a flagged row and names the way out', () => {
    const refusal = applyRefusal(2, false)
    expect(refusal).toContain('2 payslip row(s)')
    expect(refusal).toContain('TWICE')
    expect(refusal).toContain(ACKNOWLEDGE_FLAG)
  })

  it('a person who looked can lift the stop: the row may be a real bruttolöneavdrag', () => {
    expect(applyRefusal(2, true)).toBeNull()
  })
})

describe('describeRow', () => {
  it('shows where a row comes from, which is where the customer removes it', () => {
    expect(describeRow({ item_type: 'gross_deduction_other', description: 'x', amount: -1, source_recurring_line_id: 'r' })).toContain('recurring line')
    expect(describeRow({ item_type: 'benefit_car', description: 'x', amount: 1, source_benefit_id: 'b' })).toContain('benefit register')
    expect(describeRow({ item_type: 'bonus', description: 'x', amount: 1 })).toContain('hand-entered')
  })

  it('keeps the sign and the öre', () => {
    expect(describeRow({ item_type: 'gross_deduction_other', description: '', amount: -670.17 })).toContain('-670,17')
  })
})
