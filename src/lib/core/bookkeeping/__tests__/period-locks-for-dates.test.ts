/**
 * resolvePeriodLocksForDates: the period verdict for several dates in two
 * reads (crm#1923, the approval queue). It must answer each date exactly as
 * resolvePeriodLockForDate answers it alone, the failures included: a lock
 * that could not be read is never reported as open.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolvePeriodLockForDate, resolvePeriodLocksForDates } from '../period-status'

const COMPANY = 'company-1'

interface Year {
  id: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

const YEAR_2025: Year = { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, locked_at: '2026-02-01T08:00:00Z' }
const YEAR_2026: Year = { id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }

describe('resolvePeriodLocksForDates', () => {
  it('reads nothing for no dates', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()

    const locks = await resolvePeriodLocksForDates(supabase as never, COMPANY, [])

    expect(locks.size).toBe(0)
    expect(findCall('company_settings', 'select')).toBeUndefined()
  })

  it('judges every date from one settings read and one period read spanning the dates', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: '2026-10-31' } })
    enqueue({ data: [YEAR_2025, YEAR_2026] })

    const locks = await resolvePeriodLocksForDates(supabase as never, COMPANY, [
      '2026-11-03',
      '2026-10-05',
      '2026-10-31',
      '2026-11-03',
    ])

    // On or before the company lock date: locked through it, with the year for context.
    expect(locks.get('2026-10-05')).toEqual({
      status: { period_id: 'fp-2026', status: 'locked', lock_date: '2026-10-31' },
      layer: 'company_lock_date',
    })
    expect(locks.get('2026-10-31')?.layer).toBe('company_lock_date')
    // The day after it, in an open year.
    expect(locks.get('2026-11-03')).toEqual({
      status: { period_id: 'fp-2026', status: 'open', lock_date: null },
      layer: null,
    })
    expect(locks.size).toBe(3)

    expect(findCalls('company_settings', 'select')).toHaveLength(1)
    expect(findCalls('fiscal_periods', 'select')).toEqual([['id, period_start, period_end, is_closed, locked_at']])
    expect(findCall('fiscal_periods', 'eq')).toEqual(['company_id', COMPANY])
    // Every year that can cover one of the dates: starts by the last, ends from the first.
    expect(findCall('fiscal_periods', 'lte')).toEqual(['period_start', '2026-11-03'])
    expect(findCall('fiscal_periods', 'gte')).toEqual(['period_end', '2026-10-05'])
  })

  it("tells a year's own lock and its closing apart, and a date no year covers", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({
      data: [YEAR_2025, { ...YEAR_2026, locked_at: '2026-11-10T09:30:00Z' }],
    })

    const locks = await resolvePeriodLocksForDates(supabase as never, COMPANY, ['2025-06-01', '2026-06-01', '2027-01-15'])

    expect(locks.get('2025-06-01')).toEqual({
      status: { period_id: 'fp-2025', status: 'closed', lock_date: null },
      layer: 'fiscal_period',
    })
    expect(locks.get('2026-06-01')).toEqual({
      status: { period_id: 'fp-2026', status: 'locked', lock_date: '2026-11-10T09:30:00Z' },
      layer: 'fiscal_period',
    })
    // Verified: no covering year. Open, as the single read answers it.
    expect(locks.get('2027-01-15')).toEqual({
      status: { period_id: null, status: 'open', lock_date: null },
      layer: null,
    })
  })

  it('fails closed for every date when the company lock date cannot be read', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'PGRST301 JWT expired' } })

    const locks = await resolvePeriodLocksForDates(supabase as never, COMPANY, ['2026-10-05', '2026-11-03'])

    for (const date of ['2026-10-05', '2026-11-03']) {
      expect(locks.get(date)).toEqual({
        status: { period_id: null, status: 'locked', lock_date: null, lookup_failed: true },
        layer: null,
      })
    }
    expect(findCall('fiscal_periods', 'select')).toBeUndefined()
  })

  it('fails closed when the years cannot be read, except behind the company lock date, which locks on its own', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: '2026-10-31' } })
    enqueue({ data: null, error: { message: 'statement timeout' } })

    const locks = await resolvePeriodLocksForDates(supabase as never, COMPANY, ['2026-10-05', '2026-11-03'])

    expect(locks.get('2026-10-05')).toEqual({
      status: { period_id: null, status: 'locked', lock_date: '2026-10-31' },
      layer: 'company_lock_date',
    })
    expect(locks.get('2026-11-03')?.status).toEqual({ period_id: null, status: 'locked', lock_date: null, lookup_failed: true })
  })

  it('fails closed for a date two years cover, as the single read does on its multiple-rows error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ data: [YEAR_2026, { ...YEAR_2026, id: 'fp-2026-twin' }] })

    const locks = await resolvePeriodLocksForDates(supabase as never, COMPANY, ['2026-06-01'])

    expect(locks.get('2026-06-01')?.status.lookup_failed).toBe(true)
    expect(locks.get('2026-06-01')?.status.status).toBe('locked')
  })

  it('answers each date as the single read answers it', async () => {
    const cases: Array<{ lockThrough: string | null; year: Year | null; date: string }> = [
      { lockThrough: null, year: YEAR_2026, date: '2026-03-01' },
      { lockThrough: '2026-06-30', year: YEAR_2026, date: '2026-03-01' },
      { lockThrough: '2026-06-30', year: YEAR_2026, date: '2026-07-01' },
      { lockThrough: null, year: { ...YEAR_2026, locked_at: '2026-11-10T09:30:00Z' }, date: '2026-03-01' },
      { lockThrough: null, year: { ...YEAR_2026, is_closed: true }, date: '2026-03-01' },
      { lockThrough: null, year: null, date: '2026-03-01' },
    ]
    for (const { lockThrough, year, date } of cases) {
      const single = createQueuedMockSupabase()
      single.enqueue({ data: { bookkeeping_locked_through: lockThrough } })
      single.enqueue({ data: year })
      const batch = createQueuedMockSupabase()
      batch.enqueue({ data: { bookkeeping_locked_through: lockThrough } })
      batch.enqueue({ data: year ? [year] : [] })

      const alone = await resolvePeriodLockForDate(single.supabase as never, COMPANY, date)
      const together = await resolvePeriodLocksForDates(batch.supabase as never, COMPANY, [date])

      expect(together.get(date)).toEqual(alone)
    }
  })
})
