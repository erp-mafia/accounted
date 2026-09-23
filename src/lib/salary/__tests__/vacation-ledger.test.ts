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

  describe('categorized vacation lines (cutover pools)', () => {
    const vacationLine = (quantity: number, category: string | null = null, savedYear: string | null = null) => ({
      item_type: 'vacation',
      quantity,
      vacation_category: category,
      vacation_saved_year: savedYear,
    })
    const bookedRun = (
      month: number,
      vacationDaysTaken: number,
      lines: Array<ReturnType<typeof vacationLine>> | undefined,
      window?: { start: string; end: string },
    ) => ({
      employee_id: EMPLOYEE_ID,
      vacation_days_taken: vacationDaysTaken,
      line_items: lines,
      salary_run: {
        period_year: 2026,
        period_month: month,
        status: 'booked',
        deviation_period_start: window?.start ?? null,
        deviation_period_end: window?.end ?? null,
      },
    })
    const CATEGORIZED_OPENING = {
      employee_id: EMPLOYEE_ID,
      cutover_date: '2026-09-01',
      vacation_paid_days_remaining: 10,
      vacation_days_taken_this_year: 8,
      vacation_saved_days_by_year: { '2024': 2, '2025': 5 },
      vacation_as_of_date: null,
      vacation_unpaid_days_remaining: 5,
      vacation_advance_days_remaining: 3,
      vacation_extra_paid_days_remaining: 2,
    }

    it('seeds the pools from the cutover row and folds extra paid days into entitled', async () => {
      queueBase({ opening: [CATEGORIZED_OPENING] })

      const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-09-13')
      expect(result.ok).toBe(true)
      const row = upserted![0]
      // paid 10 + extra paid 2 + already taken 8
      expect(row.entitled_days).toBe(20)
      expect(row.taken_days).toBe(8)
      expect(row.unpaid_days).toBe(5)
      expect(row.advance_days).toBe(3)
      expect(row.saved_days).toEqual({ '2024': 2, '2025': 5 })
      expect(row.saved_days_taken).toEqual({})
    })

    it('splits a booked run by category: paid share, own pools, oldest saved year first', async () => {
      queueBase({
        opening: [CATEGORIZED_OPENING],
        booked: [
          bookedRun(9, 7, [
            vacationLine(2),
            vacationLine(1, 'extra_paid'),
            vacationLine(3, 'saved'),
            vacationLine(1, 'unpaid'),
          ]) as never,
          bookedRun(10, 2, [vacationLine(1, 'advance'), vacationLine(1, 'saved', '2025')]) as never,
        ],
      })

      const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-11-13')
      expect(result.ok).toBe(true)
      const row = upserted![0]
      // paid: 2 + 1 (extra paid joins the paid pool) + 8 pre-cutover
      expect(row.taken_days).toBe(11)
      expect(row.unpaid_days).toBe(4)
      expect(row.advance_days).toBe(2)
      // 3 unnamed saved days: 2024 (2) first, then 1 from 2025; plus 1 named 2025.
      expect(row.saved_days_taken).toEqual({ '2024': 2, '2025': 2 })
      // The seed is never reduced in place (idempotent recompute).
      expect(row.saved_days).toEqual({ '2024': 2, '2025': 5 })
    })

    it('skips a booked run whose avvikelseperiod ended on or before the as-of date', async () => {
      // previous_month: the September run deducts August. With the default
      // as-of (day before cutover = Aug 31) August is already inside the
      // balance; an explicit as-of of Jul 31 says it is not.
      const septemberRun = bookedRun(9, 3, [vacationLine(3)], { start: '2026-08-01', end: '2026-08-31' }) as never
      const octoberRun = bookedRun(10, 1, [vacationLine(1)], { start: '2026-09-01', end: '2026-09-30' }) as never

      queueBase({ opening: [CATEGORIZED_OPENING], booked: [septemberRun, octoberRun] })
      const defaulted = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-11-13')
      expect(defaulted.ok).toBe(true)
      expect(upserted![0].taken_days).toBe(8 + 1)

      queueBase({
        opening: [{ ...CATEGORIZED_OPENING, vacation_as_of_date: '2026-07-31' }],
        booked: [septemberRun, octoberRun],
      })
      const explicit = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-11-13')
      expect(explicit.ok).toBe(true)
      expect(upserted![0].taken_days).toBe(8 + 3 + 1)
    })

    it('buckets a run into the vacation year its avvikelseperiod ends in, not its pay month', async () => {
      // Apr-Mar years under previous_month: the April 2026 run deducts March
      // leave, which belongs to the year that started 2025-04-01. The May run
      // deducts April leave and opens the new year.
      const aprilRun = bookedRun(4, 2, [vacationLine(2)], { start: '2026-03-01', end: '2026-03-31' }) as never
      const mayRun = bookedRun(5, 1, [vacationLine(1)], { start: '2026-04-01', end: '2026-04-30' }) as never
      queueBase({
        basis: 'statutory_apr_mar',
        openRows: [
          {
            id: 'row-2025',
            employee_id: EMPLOYEE_ID,
            vacation_year_start: '2025-04-01',
            entitled_days: 25,
            accrued_days: 25,
            taken_days: 0,
            saved_days: {},
            forced_payout_days: 0,
            status: 'open',
          },
        ],
        booked: [aprilRun, mayRun],
      })

      const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-05-20')
      expect(result.ok).toBe(true)
      const byYear = new Map(upserted!.map((r) => [r.vacation_year_start, r]))
      expect(byYear.get('2025-04-01')?.taken_days).toBe(2)
      expect(byYear.get('2026-04-01')?.taken_days).toBe(1)
    })

    it('is idempotent: a second sync over the same booked runs yields the same row', async () => {
      const booked = [bookedRun(9, 4, [vacationLine(1), vacationLine(2, 'saved'), vacationLine(1, 'unpaid')]) as never]
      queueBase({ opening: [CATEGORIZED_OPENING], booked })
      await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-10-13')
      const first = upserted![0]

      queueBase({
        opening: [CATEGORIZED_OPENING],
        booked,
        openRows: [{ id: 'row-1', ...first }],
      })
      await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-10-13')
      expect(upserted![0]).toEqual(first)
    })

    it('reads a legacy opening row and legacy booked rows exactly as before', async () => {
      queueBase({
        opening: [
          {
            employee_id: EMPLOYEE_ID,
            cutover_date: '2026-07-01',
            vacation_paid_days_remaining: 12.5,
            vacation_days_taken_this_year: 7,
            vacation_saved_days_by_year: { '2025': 5 },
          },
        ],
        booked: [
          { employee_id: EMPLOYEE_ID, vacation_days_taken: 2, salary_run: { period_year: 2026, period_month: 7, status: 'booked' } },
        ],
      })

      const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
      expect(result.ok).toBe(true)
      const row = upserted![0]
      expect(row.entitled_days).toBe(19.5)
      expect(row.taken_days).toBe(9)
      expect(row.unpaid_days).toBe(0)
      expect(row.advance_days).toBe(0)
      expect(row.saved_days_taken).toEqual({})
    })
  })

  it('never throws: DB errors return ok:false (non-fatal contract)', async () => {
    mock.enqueue({ data: null }) // company_settings (defaults calendar)
    mock.enqueue({ data: null, error: { message: 'boom' } }) // employees fails

    const result = await syncVacationLedgerForEmployees(supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-07-13')
    expect(result.ok).toBe(false)
  })
})
