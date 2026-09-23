import { describe, it, expect } from 'vitest'
import {
  calendarOpeningMonth,
  countAbsenceDatesInWindow,
  payslipCalendarWindow,
} from '../payslip-calendar'
import { runDeviationWindow } from '../deviation-period'

// The customer's case: the September run of a company on "föregående månads
// avvikelser". The absences that belong to this payslip are August's.
const septemberRunReadingAugust = {
  period_year: 2026,
  period_month: 9,
  deviation_period_start: '2026-08-01',
  deviation_period_end: '2026-08-31',
}

describe('payslipCalendarWindow', () => {
  it('is the avvikelseperiod when the run has one, not the pay month', () => {
    expect(payslipCalendarWindow(septemberRunReadingAugust)).toEqual({
      start: '2026-08-01',
      end: '2026-08-31',
    })
  })

  it('is the pay month for a run without stored bounds', () => {
    expect(
      payslipCalendarWindow({
        period_year: 2026,
        period_month: 9,
        deviation_period_start: null,
        deviation_period_end: null,
      }),
    ).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(payslipCalendarWindow({ period_year: 2026, period_month: 2 })).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    })
  })

  it('never disagrees with the window the engine reads', () => {
    const runs = [
      septemberRunReadingAugust,
      { period_year: 2026, period_month: 1, deviation_period_start: '2025-12-01', deviation_period_end: '2025-12-31' },
      { period_year: 2026, period_month: 9, deviation_period_start: '2026-07-20', deviation_period_end: '2026-08-19' },
      { period_year: 2026, period_month: 9, deviation_period_start: null, deviation_period_end: null },
      // Half a window is no window: the engine falls back to the pay month.
      { period_year: 2026, period_month: 9, deviation_period_start: '2026-08-01', deviation_period_end: null },
    ]
    for (const run of runs) {
      expect(payslipCalendarWindow(run)).toEqual(runDeviationWindow(run))
    }
  })
})

describe('calendarOpeningMonth', () => {
  it('opens on the deviation month, not the pay month', () => {
    expect(calendarOpeningMonth(payslipCalendarWindow(septemberRunReadingAugust))).toBe('2026-08-01')
  })

  it('opens on the pay month when the run reads its own month', () => {
    expect(calendarOpeningMonth(payslipCalendarWindow({ period_year: 2026, period_month: 9 }))).toBe('2026-09-01')
  })

  it('crosses the year boundary with the window', () => {
    expect(
      calendarOpeningMonth(
        payslipCalendarWindow({
          period_year: 2026,
          period_month: 1,
          deviation_period_start: '2025-12-01',
          deviation_period_end: '2025-12-31',
        }),
      ),
    ).toBe('2025-12-01')
  })

  it('opens on the earlier month of a window that straddles two', () => {
    expect(calendarOpeningMonth({ start: '2026-07-20', end: '2026-08-19' })).toBe('2026-07-01')
  })
})

describe('countAbsenceDatesInWindow', () => {
  const rows = [
    { absence_date: '2026-08-12', absence_type: 'sick' },
    { absence_date: '2026-08-13', absence_type: 'sick' },
    { absence_date: '2026-08-20', absence_type: 'vab' },
    { absence_date: '2026-08-25', absence_type: 'parental' },
    { absence_date: '2026-08-26', absence_type: 'pregnancy' },
    { absence_date: '2026-08-27', absence_type: 'care_relative' },
    { absence_date: '2026-08-28', absence_type: 'unpaid_leave' },
    // September rows belong to the NEXT run under previous_month.
    { absence_date: '2026-09-02', absence_type: 'sick' },
    { absence_date: '2026-09-03', absence_type: 'vab' },
  ]

  it('counts the days the run deducts: August for the September run', () => {
    expect(countAbsenceDatesInWindow(rows, payslipCalendarWindow(septemberRunReadingAugust))).toEqual({
      sick: 2,
      vab: 1,
      parental: 3,
    })
  })

  it('counted the wrong month when fed the pay month (the defect this guards)', () => {
    expect(countAbsenceDatesInWindow(rows, { start: '2026-09-01', end: '2026-09-30' })).toEqual({
      sick: 1,
      vab: 1,
      parental: 0,
    })
  })

  it('includes both window bounds and counts a date once per category', () => {
    const edge = [
      { absence_date: '2026-08-01', absence_type: 'sick' },
      { absence_date: '2026-08-31', absence_type: 'sick' },
      { absence_date: '2026-08-31', absence_type: 'sick' },
      { absence_date: '2026-07-31', absence_type: 'sick' },
      { absence_date: '2026-09-01', absence_type: 'sick' },
    ]
    expect(countAbsenceDatesInWindow(edge, { start: '2026-08-01', end: '2026-08-31' }).sick).toBe(2)
  })

  it('is all zeros for no rows', () => {
    expect(countAbsenceDatesInWindow([], { start: '2026-08-01', end: '2026-08-31' })).toEqual({
      sick: 0,
      vab: 0,
      parental: 0,
    })
  })
})
