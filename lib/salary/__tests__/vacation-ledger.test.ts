/**
 * Vacation-year boundaries + ledger sync (payroll gap-closure 3.2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  getClosableYearStart,
  getVacationYearBounds,
  getVacationYearStart,
} from '@/lib/salary/vacation-year'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'

describe('vacation-year helpers', () => {
  it('calendar basis: Jan 1 boundary', () => {
    expect(getVacationYearStart('2026-07-13', 'calendar')).toBe('2026-01-01')
    expect(getVacationYearStart('2026-01-01', 'calendar')).toBe('2026-01-01')
    expect(getVacationYearBounds('2026-01-01')).toEqual({ start: '2026-01-01', end: '2027-01-01' })
    expect(getClosableYearStart('2026-07-13', 'calendar')).toBe('2025-01-01')
  })

  it('statutory basis: Apr 1 boundary, Jan-Mar belongs to the previous start', () => {
    expect(getVacationYearStart('2026-07-13', 'statutory_apr_mar')).toBe('2026-04-01')
    expect(getVacationYearStart('2026-03-31', 'statutory_apr_mar')).toBe('2025-04-01')
    expect(getVacationYearStart('2026-04-01', 'statutory_apr_mar')).toBe('2026-04-01')
    expect(getVacationYearBounds('2025-04-01')).toEqual({ start: '2025-04-01', end: '2026-04-01' })
    expect(getClosableYearStart('2026-02-15', 'statutory_apr_mar')).toBe('2024-04-01')
  })
})

describe('syncVacationLedgerForEmployees', () => {
  const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient
  let upserted: Array<Record<string, unknown>> | null

  beforeEach(() => {
    vi.clearAllMocks()
    upserted = null
    mock = createQueuedMockSupabase()
    // Wrap from() to capture the upsert payload while keeping queue behavior.
    const originalFrom = mock.supabase.from
    mock.supabase.from = vi.fn((table: string) => {
      const chain = originalFrom(table) as Record<string, unknown>
      return new Proxy(chain as object, {
        get(target, prop) {
          if (prop === 'upsert' && table === 'employee_vacation_balances') {
            return (rows: Array<Record<string, unknown>>) => {
              upserted = rows
              return (target as Record<string, (...a: unknown[]) => unknown>).upsert?.(rows) ?? target
            }
          }
          return (target as Record<string | symbol, unknown>)[prop]
        },
      })
    }) as never
    supabase = mock.supabase as unknown as SupabaseClient
  })

  const queueBase = (over: {
    basis?: string
    booked?: Array<{ employee_id: string; vacation_days_taken: number; salary_run: { period_year: number; period_month: number; status: string } }>
    openRows?: Array<Record<string, unknown>>
    opening?: Array<Record<string, unknown>>
    savedLegacy?: number
    employmentStart?: string
  }) => {
    mock.enqueue({ data: { salary_vacation_year_basis: over.basis ?? 'calendar' } }) // company_settings
    mock.enqueue({
      data: [
        {
          id: EMPLOYEE_ID,
          vacation_days_per_year: 25,
          vacation_days_saved: over.savedLegacy ?? 0,
          vacation_rule: 'procentregeln',
          // Long-tenured by default so the pro-rating cases stay opt-in.
          employment_start: over.employmentStart ?? '2015-01-01',
        },
      ],
    }) // employees
    mock.enqueue({ data: over.opening ?? [] }) // opening balances
    mock.enqueue({ data: over.openRows ?? [] }) // existing open ledger rows
    mock.enqueue({ data: over.booked ?? [] }) // booked sre rows
    mock.enqueue({ data: null }) // upsert result
  }

  it('lazy-seeds the current year and recomputes taken from booked runs', async () => {
    queueBase({
      booked: [
        { employee_id: EMPLOYEE_ID, vacation_days_taken: 3, salary_run: { period_year: 2026, period_month: 6, status: 'booked' } },
        { employee_id: EMPLOYEE_ID, vacation_days_taken: 2, salary_run: { period_year: 2026, period_month: 7, status: 'booked' } },
        // Prior year: outside the current vacation year bounds.
        { employee_id: EMPLOYEE_ID, vacation_days_taken: 5, salary_run: { period_year: 2025, period_month: 7, status: 'booked' } },
      ],
    })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    expect(upserted).toHaveLength(1)
    const row = upserted![0]
    expect(row.vacation_year_start).toBe('2026-01-01')
    expect(row.entitled_days).toBe(25)
    expect(row.taken_days).toBe(5)
    // Calendar basis: sammanfallande year, accrued stays 0.
    expect(row.accrued_days).toBe(0)
  })

  it('pro-rates entitled days for a mid-intjänandeår hire (Semesterlagen 7 §)', async () => {
    // Hired 2025-05-19. For semesteråret starting 2026-04-01 the intjänandeår
    // is 2025-04-01 to 2026-04-01 (365 days), of which 317 were employed:
    // 317/365 x 25 = 21.71, rounded UP to 22. Reporting a flat 25 told the
    // employee they had three paid days they had not earned.
    queueBase({ basis: 'statutory_apr_mar', employmentStart: '2025-05-19' })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    const row = upserted![0]
    expect(row.vacation_year_start).toBe('2026-04-01')
    expect(row.entitled_days).toBe(22)
  })

  it('gives a full entitlement to someone employed the whole intjänandeår', async () => {
    queueBase({ basis: 'statutory_apr_mar', employmentStart: '2015-01-01' })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    expect(upserted![0].entitled_days).toBe(25)
  })

  it('accrues from the employment date, not the vacation-year boundary', async () => {
    // Hired 2026-07-01, three whole months into the year starting 2026-04-01
    // as of 2026-10-15: 3/12 x 25 = 6.25, held to half days = 6.5. Counting
    // from the year boundary instead would credit 12.5.
    queueBase({ basis: 'statutory_apr_mar', employmentStart: '2026-07-01' })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-10-15')
    expect(result.ok).toBe(true)
    expect(upserted![0].accrued_days).toBe(6.5)
  })

  it('keeps the flat entitlement on a sammanfallande calendar year', async () => {
    // Earning and taking share the year there, commonly with förskottssemester,
    // so mid-year hires are a CBA question rather than a statutory one.
    queueBase({ basis: 'calendar', employmentStart: '2026-05-19' })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    expect(upserted![0].entitled_days).toBe(25)
  })

  it('seeds entitled + saved days from the cutover opening row', async () => {
    queueBase({
      opening: [
        {
          employee_id: EMPLOYEE_ID,
          cutover_date: '2026-07-01',
          vacation_paid_days_remaining: 12.5,
          vacation_saved_days_by_year: { '2025': 5 },
        },
      ],
    })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    const row = upserted![0]
    expect(row.entitled_days).toBe(12.5)
    expect(row.saved_days).toEqual({ '2025': 5 })
  })

  it('seeds cutover-year entitled and taken including pre-cutover taken days', async () => {
    queueBase({
      opening: [
        {
          employee_id: EMPLOYEE_ID,
          cutover_date: '2026-07-01',
          vacation_paid_days_remaining: 12.5,
          vacation_days_taken_this_year: 7,
          vacation_saved_days_by_year: {},
        },
      ],
      booked: [
        { employee_id: EMPLOYEE_ID, vacation_days_taken: 2, salary_run: { period_year: 2026, period_month: 7, status: 'booked' } },
      ],
    })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    const row = upserted![0]
    // entitled = remaining + pre-cutover taken; taken = booked + pre-cutover.
    // Remaining (entitled - taken) stays 12.5 - 2 = 10.5.
    expect(row.entitled_days).toBe(19.5)
    expect(row.taken_days).toBe(9)
  })

  it('seeds legacy vacation_days_saved under the previous year when no cutover row exists', async () => {
    queueBase({ savedLegacy: 4 })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    const row = upserted![0]
    expect(row.saved_days).toEqual({ '2025': 4 })
  })

  it('recomputes existing open rows instead of duplicating them', async () => {
    queueBase({
      openRows: [
        {
          id: 'row-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2026-01-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 99, // stale: recompute must overwrite from booked runs
          saved_days: { '2025': 2 },
          forced_payout_days: 0,
          status: 'open',
        },
      ],
      booked: [
        { employee_id: EMPLOYEE_ID, vacation_days_taken: 1, salary_run: { period_year: 2026, period_month: 5, status: 'booked' } },
      ],
    })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    expect(upserted).toHaveLength(1)
    const row = upserted![0]
    expect(row.taken_days).toBe(1)
    expect(row.saved_days).toEqual({ '2025': 2 })
  })

  it('re-derives a stale entitled_days on existing rows (recompute path)', async () => {
    // Same mid-intjänandeår hire as the seed-path case: 317/365 x 25 rounds
    // UP to 22. The stored row still says the flat 25 from before pro-rating
    // existed; carrying it verbatim would preserve the overstatement forever.
    queueBase({
      basis: 'statutory_apr_mar',
      employmentStart: '2025-05-19',
      openRows: [
        {
          id: 'row-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2026-04-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 0,
          saved_days: {},
          forced_payout_days: 0,
          status: 'open',
        },
      ],
    })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    expect(upserted).toHaveLength(1)
    expect(upserted![0].entitled_days).toBe(22)
  })

  it('recompute keeps the opening-derived values on the cutover-year row', async () => {
    // The opening balance outranks recomputation for the year containing
    // cutover_date, and its pre-cutover taken days must survive every sync
    // (not just the first seed) or the seeded value evaporates.
    queueBase({
      opening: [
        {
          employee_id: EMPLOYEE_ID,
          cutover_date: '2026-07-01',
          vacation_paid_days_remaining: 10,
          vacation_days_taken_this_year: 8,
          vacation_saved_days_by_year: {},
        },
      ],
      openRows: [
        {
          id: 'row-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2026-01-01',
          entitled_days: 10, // stale pre-fix seed: remaining only
          accrued_days: 0,
          taken_days: 0,
          saved_days: {},
          forced_payout_days: 0,
          status: 'open',
        },
      ],
      booked: [
        { employee_id: EMPLOYEE_ID, vacation_days_taken: 2, salary_run: { period_year: 2026, period_month: 7, status: 'booked' } },
      ],
    })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(true)
    expect(upserted).toHaveLength(1)
    const row = upserted![0]
    expect(row.entitled_days).toBe(18) // remaining 10 + pre-cutover taken 8
    expect(row.taken_days).toBe(10) // booked 2 + pre-cutover taken 8
  })

  it('accrues toward next year on the statutory basis (elapsed months / 12)', async () => {
    queueBase({ basis: 'statutory_apr_mar' })

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-10-15')
    expect(result.ok).toBe(true)
    const row = upserted![0]
    expect(row.vacation_year_start).toBe('2026-04-01')
    // Apr -> Oct = 6 whole months: 6/12 x 25 = 12.5.
    expect(row.accrued_days).toBe(12.5)
  })

  it('never throws: DB errors return ok:false (non-fatal contract)', async () => {
    mock.enqueue({ data: null }) // company_settings (defaults calendar)
    mock.enqueue({ data: null, error: { message: 'boom' } }) // employees fails

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(false)
  })
})
