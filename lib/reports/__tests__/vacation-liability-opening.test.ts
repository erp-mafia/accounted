/**
 * Vacation-liability report: cutover opening-balance terms
 * (payroll gap-closure 2.2).
 *
 * A mid-year switcher's semesterlöneskuld arrived via SIE opening balances
 * on 2920/2940; the per-employee report must include the opening SEK terms,
 * start remaining days from the imported balance, and add saved-days from
 * the origin-year map.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'

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

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('generateVacationLiability with opening balances', () => {
  it('adds opening SEK terms and starts days from the imported balance', async () => {
    mock.enqueue({ data: [EMPLOYEE] }) // employees page
    mock.enqueue({
      data: [
        {
          employee_id: EMPLOYEE_ID,
          vacation_accrual: 4200,
          vacation_accrual_avgifter: 1319.64,
          avgifter_rate: 0.3142,
          vacation_days_taken: 3,
          salary_run: { period_year: 2026, status: 'booked' },
        },
      ],
    }) // booked sre page
    mock.enqueue({ data: [] }) // vacation ledger (none yet)
    mock.enqueue({
      data: [
        {
          employee_id: EMPLOYEE_ID,
          cutover_date: '2026-07-01',
          vacation_paid_days_remaining: 12.5,
          vacation_saved_days_by_year: { '2025': 5, '2024': 2 },
          opening_semester_liability: 42000,
          opening_semester_liability_avgifter: 13196.4,
        },
      ],
    }) // opening balances

    const report = await generateVacationLiability(supabase, COMPANY_ID, 2026)

    expect(report.rows).toHaveLength(1)
    const row = report.rows[0]
    // Opening SEK + in-system accrual.
    expect(row.accruedAmount).toBe(46200)
    expect(row.accruedAvgifter).toBe(14516.04)
    expect(row.totalLiability).toBe(60716.04)
    // Remaining starts from the imported 12.5, not the 25-day entitlement.
    expect(row.vacationDaysRemaining).toBe(9.5)
    // Saved days: master-row 0 + origin-year map 5 + 2.
    expect(row.vacationDaysSaved).toBe(7)
    expect(report.totals.totalLiability).toBe(60716.04)
  })

  it('ignores opening rows for report years before the cutover year', async () => {
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({ data: [] }) // no booked runs in 2025
    mock.enqueue({ data: [] }) // vacation ledger
    mock.enqueue({
      data: [
        {
          employee_id: EMPLOYEE_ID,
          cutover_date: '2026-07-01',
          vacation_paid_days_remaining: 12.5,
          vacation_saved_days_by_year: {},
          opening_semester_liability: 42000,
          opening_semester_liability_avgifter: 13196.4,
        },
      ],
    })

    const report = await generateVacationLiability(supabase, COMPANY_ID, 2025)

    expect(report.rows[0].accruedAmount).toBe(0)
    expect(report.rows[0].vacationDaysRemaining).toBe(25)
  })

  it('is a no-op for companies without opening rows', async () => {
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({
      data: [
        {
          employee_id: EMPLOYEE_ID,
          vacation_accrual: 4200,
          vacation_accrual_avgifter: 1319.64,
          avgifter_rate: 0.3142,
          vacation_days_taken: 0,
          salary_run: { period_year: 2026, status: 'booked' },
        },
      ],
    })
    mock.enqueue({ data: [] }) // vacation ledger
    mock.enqueue({ data: [] }) // no opening rows

    const report = await generateVacationLiability(supabase, COMPANY_ID, 2026)

    expect(report.rows[0].accruedAmount).toBe(4200)
    expect(report.rows[0].vacationDaysRemaining).toBe(25)
    expect(report.rows[0].vacationDaysSaved).toBe(0)
  })

  it('prefers the vacation ledger for DAYS when a row exists (v2)', async () => {
    mock.enqueue({ data: [EMPLOYEE] })
    mock.enqueue({
      data: [
        {
          employee_id: EMPLOYEE_ID,
          vacation_accrual: 4200,
          vacation_accrual_avgifter: 1319.64,
          avgifter_rate: 0.3142,
          // The sre says 3 taken, but the ledger (recomputed, incl. cutover
          // seed) is authoritative for days.
          vacation_days_taken: 3,
          salary_run: { period_year: 2026, status: 'booked' },
        },
      ],
    })
    mock.enqueue({
      data: [
        {
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2026-01-01',
          entitled_days: 12.5,
          taken_days: 4,
          saved_days: { '2025': 5, '2024': 2 },
        },
      ],
    }) // vacation ledger row wins for days
    mock.enqueue({
      data: [
        {
          employee_id: EMPLOYEE_ID,
          cutover_date: '2026-07-01',
          vacation_paid_days_remaining: 12.5,
          vacation_saved_days_by_year: { '2025': 5 },
          opening_semester_liability: 42000,
          opening_semester_liability_avgifter: 13196.4,
        },
      ],
    })

    const report = await generateVacationLiability(supabase, COMPANY_ID, 2026)
    const row = report.rows[0]

    // Days come from the ledger, not entitled-minus-sre-taken.
    expect(row.vacationDaysEntitled).toBe(12.5)
    expect(row.vacationDaysTaken).toBe(4)
    expect(row.vacationDaysRemaining).toBe(8.5)
    expect(row.vacationDaysSaved).toBe(7)
    // SEK still derives from runs + opening terms.
    expect(row.accruedAmount).toBe(46200)
  })
})
