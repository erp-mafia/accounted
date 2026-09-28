/**
 * Vacation-liability report: the SEK window.
 *
 * Per-run accruals credit 2920/2940 and are never relieved when vacation is
 * taken; the semesterårsavslut trues the balance up at the vacation-year
 * end. So the report as of a date must be the latest closed year's computed
 * liability plus accruals booked after that year end, or, before any close,
 * everything booked so far. A calendar-year window dropped earlier years
 * still on 2920 and kept adding a cutover liability a close had replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { generateVacationLiability, vacationLiabilityCheck } from '@/lib/reports/vacation-liability'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const EMPLOYEE = {
  id: EMPLOYEE_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer_last4: '0000',
  vacation_rule: 'procentregeln',
  vacation_days_per_year: 25,
  vacation_days_saved: 0,
}

function run(paymentDate: string, accrual: number, daysTaken = 0) {
  return {
    employee_id: EMPLOYEE_ID,
    vacation_accrual: accrual,
    vacation_accrual_avgifter: Math.round(accrual * 0.3142 * 100) / 100,
    avgifter_rate: 0.3142,
    vacation_days_taken: daysTaken,
    salary_run: { payment_date: paymentDate, status: 'booked' },
  }
}

const CUTOVER_OPENING = {
  employee_id: EMPLOYEE_ID,
  cutover_date: '2025-01-01',
  vacation_paid_days_remaining: 20,
  vacation_saved_days_by_year: {},
  opening_semester_liability: 42000,
  opening_semester_liability_avgifter: 13196.4,
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('generateVacationLiability SEK window', () => {
  it('before any close, keeps every booked accrual, not only this calendar year', async () => {
    mock.enqueue({ data: null }) // basis: calendar
    mock.enqueue({ data: [] }) // no closures
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({ data: [run('2025-11-25', 4000, 2), run('2026-02-25', 4200, 3)] })
    mock.enqueue({ data: [] }) // ledger
    mock.enqueue({ data: [CUTOVER_OPENING] })

    const report = await generateVacationLiability(supabase, COMPANY_ID, '2026-12-31')
    const row = report.rows[0]

    // Cutover opening + 2025 accrual + 2026 accrual: all still on 2920.
    expect(row.accruedAmount).toBe(50200)
    expect(report.closedYear).toBeNull()
    // No lower bound on the run window, only the as-of date.
    expect(mock.findCalls('salary_run_employees', 'gt')).toHaveLength(0)
    expect(mock.findCall('salary_run_employees', 'lte')).toEqual(['salary_runs.payment_date', '2026-12-31'])
    // Days (no ledger row) count the current vacation year's runs only.
    expect(row.vacationDaysTaken).toBe(3)
  })

  it('after a close, starts from the closed liability and drops the cutover opening', async () => {
    mock.enqueue({ data: null }) // basis: calendar
    mock.enqueue({
      data: [
        {
          vacation_year_start: '2025-01-01',
          report: { rows: [{ employee_id: EMPLOYEE_ID, computed_liability_sek: 10000, avgifter_rate: 0.3142 }] },
        },
      ],
    })
    mock.enqueue({ data: [EMPLOYEE] })
    // The server filter keeps runs after 2025-12-31; the client guard drops
    // anything the filter let through by mistake.
    mock.enqueue({ data: [run('2025-12-25', 9999), run('2026-01-25', 4200)] })
    mock.enqueue({ data: [] }) // ledger
    mock.enqueue({ data: [CUTOVER_OPENING] })

    const report = await generateVacationLiability(supabase, COMPANY_ID, '2026-12-31')
    const row = report.rows[0]

    expect(report.closedYear).toEqual({ start: '2025-01-01', end: '2025-12-31' })
    expect(mock.findCall('salary_run_employees', 'gt')).toEqual(['salary_runs.payment_date', '2025-12-31'])
    expect(row.accruedAmount).toBe(14200)
    // 2940: the close's per-employee rate on its liability, plus the run's.
    expect(row.accruedAvgifter).toBe(4461.64)
  })

  it('as of the closed year end, equals the trued-up liability', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({
      data: [
        {
          vacation_year_start: '2025-01-01',
          report: { rows: [{ employee_id: EMPLOYEE_ID, computed_liability_sek: 10000, avgifter_rate: 0.1021 }] },
        },
      ],
    })
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })

    const report = await generateVacationLiability(supabase, COMPANY_ID, '2025-12-31')

    expect(report.rows[0].accruedAmount).toBe(10000)
    expect(report.rows[0].accruedAvgifter).toBe(1021)
  })

  it('ignores a closure whose year ends after the date', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({
      data: [
        {
          vacation_year_start: '2026-01-01',
          report: { rows: [{ employee_id: EMPLOYEE_ID, computed_liability_sek: 99999, avgifter_rate: 0.3142 }] },
        },
        {
          vacation_year_start: '2025-01-01',
          report: { rows: [{ employee_id: EMPLOYEE_ID, computed_liability_sek: 10000, avgifter_rate: 0.3142 }] },
        },
      ],
    })
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({ data: [run('2026-03-25', 4200)] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })

    const report = await generateVacationLiability(supabase, COMPANY_ID, '2026-06-30')

    expect(report.closedYear?.end).toBe('2025-12-31')
    expect(report.rows[0].accruedAmount).toBe(14200)
  })

  it('follows the April to March basis for the close boundary and the day columns', async () => {
    mock.enqueue({ data: { salary_vacation_year_basis: 'statutory_apr_mar' } })
    mock.enqueue({
      data: [
        {
          vacation_year_start: '2025-04-01',
          report: { rows: [{ employee_id: EMPLOYEE_ID, computed_liability_sek: 10000, avgifter_rate: 0.3142 }] },
        },
      ],
    })
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({ data: [run('2026-04-25', 4200)] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })

    const report = await generateVacationLiability(supabase, COMPANY_ID, '2026-12-31')

    expect(report.vacationYearStart).toBe('2026-04-01')
    expect(report.closedYear).toEqual({ start: '2025-04-01', end: '2026-03-31' })
    expect(mock.findCall('salary_run_employees', 'gt')).toEqual(['salary_runs.payment_date', '2026-03-31'])
    expect(mock.findCall('employee_vacation_balances', 'eq')).toEqual(['company_id', COMPANY_ID])
    expect(mock.findCalls('employee_vacation_balances', 'eq')).toContainEqual(['vacation_year_start', '2026-04-01'])
    expect(report.rows[0].accruedAmount).toBe(14200)
  })

  it('surfaces a failed closure read instead of reporting without the anchor', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: null, error: { message: 'boom' } })

    await expect(generateVacationLiability(supabase, COMPANY_ID, '2026-12-31')).rejects.toBeTruthy()
  })
})

describe('vacationLiabilityCheck', () => {
  it('reports booked minus report per account', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({ data: [run('2026-01-25', 4200)] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    const report = await generateVacationLiability(supabase, COMPANY_ID, '2026-12-31')

    expect(vacationLiabilityCheck(report, { booked2920: 4200, booked2940: 1319.64 })).toEqual({
      booked2920: 4200,
      booked2940: 1319.64,
      difference2920: 0,
      difference2940: 0,
    })
    expect(vacationLiabilityCheck(report, { booked2920: 5000.1, booked2940: 1000 })).toMatchObject({
      difference2920: 800.1,
      difference2940: -319.64,
    })
  })
})
