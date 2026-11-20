import { describe, expect, it } from 'vitest'
import { runRowVacation } from '../run-row-vacation'

describe('runRowVacation', () => {
  it('reads the per-run semesterersättning an hourly employee is paid, with nothing accrued', () => {
    // vacation_rule 'semesterersattning': 12 % of 12 h x 150 kr on the payslip.
    expect(
      runRowVacation({
        vacation_accrual: 0,
        line_items: [
          { item_type: 'hourly_salary', amount: 1800 },
          { item_type: 'semesterersattning', amount: 216 },
        ],
      }),
    ).toEqual({ accrued: 0, paidOut: 216 })
  })

  it('reads the accrual of a procentregeln row, with nothing paid out', () => {
    expect(
      runRowVacation({
        vacation_accrual: 3600,
        line_items: [{ item_type: 'monthly_salary', amount: 30000 }],
      }),
    ).toEqual({ accrued: 3600, paidOut: 0 })
  })

  it('sums every semesterersättning line, a hand-entered final settlement included', () => {
    expect(
      runRowVacation({
        vacation_accrual: 120.1,
        line_items: [
          { item_type: 'semesterersattning', amount: 0.1 },
          { item_type: 'semesterersattning', amount: 0.2 },
          { item_type: 'vacation', amount: 500 },
        ],
      }),
    ).toEqual({ accrued: 120.1, paidOut: 0.3 })
  })

  it('reads numeric strings as PostgREST may return them', () => {
    expect(
      runRowVacation({
        vacation_accrual: '0',
        line_items: [{ item_type: 'semesterersattning', amount: '486' }],
      }),
    ).toEqual({ accrued: 0, paidOut: 486 })
  })

  it('treats a row without line items or accrual as zero', () => {
    expect(runRowVacation({ vacation_accrual: null })).toEqual({ accrued: 0, paidOut: 0 })
    expect(runRowVacation({ vacation_accrual: undefined, line_items: null })).toEqual({ accrued: 0, paidOut: 0 })
  })
})
