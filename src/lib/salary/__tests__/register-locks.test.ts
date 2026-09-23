/**
 * Unit tests for lib/salary/register-locks.ts: which salary runs lock the
 * absence and worked-days registers, and for which dates.
 *
 * The rule: a run in review, approved, paid or booked locks every date of
 * its deviation window (stored bounds, or the pay month for a legacy NULL
 * window). Draft runs and corrected originals never lock.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  REGISTER_LOCKING_RUN_STATUSES,
  assertRegisterDatesUnlocked,
  assertRegisterRangeUnlocked,
  findRunLockingDates,
  findRunLockingRange,
} from '@/lib/salary/register-locks'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** September pay month, calculated, created before the window columns existed. */
const REVIEW_LEGACY_SEPTEMBER = {
  id: 'run-sep',
  status: 'review',
  period_year: 2026,
  period_month: 9,
  deviation_period_start: null,
  deviation_period_end: null,
}

/** October pay month, booked, reading September ("previous_month"). */
const BOOKED_OCTOBER_READS_SEPTEMBER = {
  id: 'run-oct',
  status: 'booked',
  period_year: 2026,
  period_month: 10,
  deviation_period_start: '2026-09-01',
  deviation_period_end: '2026-09-30',
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

const fromCalls = () =>
  (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('findRunLockingDates', () => {
  it('reports no lock when the company has no locking runs', async () => {
    mock.enqueue({ data: [] })
    const result = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-15'])
    expect(result).toEqual({ ok: true, lock: null })
  })

  it('never queries for an empty date list', async () => {
    const result = await findRunLockingDates(supabase, COMPANY_ID, [])
    expect(result).toEqual({ ok: true, lock: null })
    expect(fromCalls()).toEqual([])
  })

  it('loads only review/approved/paid/booked runs of the company, one query, literal select', async () => {
    mock.enqueue({ data: [] })
    await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-15'])

    expect(fromCalls()).toEqual(['salary_runs'])
    expect(REGISTER_LOCKING_RUN_STATUSES).toEqual(['review', 'approved', 'paid', 'booked'])
    expect(mock.findCall('salary_runs', 'in')).toEqual(['status', ['review', 'approved', 'paid', 'booked']])
    expect(mock.findCalls('salary_runs', 'eq')).toEqual([['company_id', COMPANY_ID]])
    const selected = mock.findCall('salary_runs', 'select')?.[0] as string
    for (const column of ['id', 'status', 'period_year', 'period_month', 'deviation_period_start', 'deviation_period_end']) {
      expect(selected).toContain(column)
    }
  })

  it('draft-only runs never lock, even when a draft row reaches the rule', async () => {
    mock.enqueue({
      data: [{ ...REVIEW_LEGACY_SEPTEMBER, id: 'run-draft', status: 'draft' }],
    })
    const result = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-15'])
    expect(result).toEqual({ ok: true, lock: null })
  })

  it('a review run with a legacy NULL window locks its pay month', async () => {
    mock.enqueue({ data: [REVIEW_LEGACY_SEPTEMBER] })
    const result = await findRunLockingDates(supabase, COMPANY_ID, [
      '2026-08-31',
      '2026-09-01',
      '2026-09-15',
      '2026-09-30',
      '2026-10-01',
    ])
    expect(result).toEqual({
      ok: true,
      lock: {
        salary_run_id: 'run-sep',
        status: 'review',
        period_year: 2026,
        period_month: 9,
        deviation_period_start: '2026-09-01',
        deviation_period_end: '2026-09-30',
        locked_dates: ['2026-09-01', '2026-09-15', '2026-09-30'],
      },
    })
  })

  it('a booked run with a stored previous-month window locks those dates and not the pay month', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER_READS_SEPTEMBER] })
    const september = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-10', '2026-10-10'])
    expect(september.ok && september.lock).toMatchObject({
      salary_run_id: 'run-oct',
      status: 'booked',
      deviation_period_start: '2026-09-01',
      deviation_period_end: '2026-09-30',
      locked_dates: ['2026-09-10'],
    })

    mock.enqueue({ data: [BOOKED_OCTOBER_READS_SEPTEMBER] })
    const october = await findRunLockingDates(supabase, COMPANY_ID, ['2026-10-10'])
    expect(october).toEqual({ ok: true, lock: null })
  })

  it('ignores a corrected original; its correction run is what locks', async () => {
    mock.enqueue({
      data: [
        { ...REVIEW_LEGACY_SEPTEMBER, id: 'run-sep-original', status: 'corrected' },
        { ...REVIEW_LEGACY_SEPTEMBER, id: 'run-sep-correction', status: 'booked' },
      ],
    })
    const result = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-15'])
    expect(result.ok && result.lock).toMatchObject({ salary_run_id: 'run-sep-correction', status: 'booked' })

    mock.enqueue({ data: [{ ...REVIEW_LEGACY_SEPTEMBER, id: 'run-sep-original', status: 'corrected' }] })
    const onlyOriginal = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-15'])
    expect(onlyOriginal).toEqual({ ok: true, lock: null })
  })

  it('names the earliest locking run when several read the dates', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER_READS_SEPTEMBER, REVIEW_LEGACY_SEPTEMBER] })
    const result = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-15'])
    expect(result.ok && result.lock?.salary_run_id).toBe('run-sep')
  })

  it('dedupes and sorts the locked dates', async () => {
    mock.enqueue({ data: [REVIEW_LEGACY_SEPTEMBER] })
    const result = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-20', '2026-09-03', '2026-09-20'])
    expect(result.ok && result.lock?.locked_dates).toEqual(['2026-09-03', '2026-09-20'])
  })

  it('surfaces a query failure as INTERNAL_ERROR instead of silently allowing the write', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const result = await findRunLockingDates(supabase, COMPANY_ID, ['2026-09-15'])
    expect(result).toEqual({ ok: false, code: 'INTERNAL_ERROR', details: { message: 'boom' } })
  })
})

describe('findRunLockingRange', () => {
  it('locks a range delete that overlaps a window, expanding only the overlap', async () => {
    mock.enqueue({ data: [REVIEW_LEGACY_SEPTEMBER] })
    const result = await findRunLockingRange(supabase, COMPANY_ID, '2026-09-25', '2026-10-05')
    expect(result.ok && result.lock).toMatchObject({
      salary_run_id: 'run-sep',
      locked_dates: ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'],
    })
    expect(fromCalls()).toEqual(['salary_runs'])
  })

  it('a range wholly inside the window locks every day of the range', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER_READS_SEPTEMBER] })
    const result = await findRunLockingRange(supabase, COMPANY_ID, '2026-09-02', '2026-09-04')
    expect(result.ok && result.lock?.locked_dates).toEqual(['2026-09-02', '2026-09-03', '2026-09-04'])
  })

  it('passes a range that misses every window', async () => {
    mock.enqueue({ data: [REVIEW_LEGACY_SEPTEMBER, BOOKED_OCTOBER_READS_SEPTEMBER] })
    const result = await findRunLockingRange(supabase, COMPANY_ID, '2026-10-01', '2026-10-31')
    expect(result).toEqual({ ok: true, lock: null })
  })
})

describe('assertRegisterDatesUnlocked / assertRegisterRangeUnlocked', () => {
  it('shapes a lock as the SALARY_REGISTER_DATES_LOCKED_BY_RUN failure with the run in details', async () => {
    mock.enqueue({ data: [REVIEW_LEGACY_SEPTEMBER] })
    const failure = await assertRegisterDatesUnlocked(supabase, COMPANY_ID, ['2026-09-15'])
    expect(failure).toEqual({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: {
        salary_run_id: 'run-sep',
        status: 'review',
        period_year: 2026,
        period_month: 9,
        deviation_period_start: '2026-09-01',
        deviation_period_end: '2026-09-30',
        locked_dates: ['2026-09-15'],
      },
    })
  })

  it('returns null when nothing locks', async () => {
    mock.enqueue({ data: [] })
    expect(await assertRegisterDatesUnlocked(supabase, COMPANY_ID, ['2026-09-15'])).toBeNull()
    mock.enqueue({ data: [] })
    expect(await assertRegisterRangeUnlocked(supabase, COMPANY_ID, '2026-09-01', '2026-09-30')).toBeNull()
  })

  it('locks a range delete inside a locked window', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER_READS_SEPTEMBER] })
    const failure = await assertRegisterRangeUnlocked(supabase, COMPANY_ID, '2026-09-10', '2026-09-11')
    expect(failure).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: { salary_run_id: 'run-oct', status: 'booked', locked_dates: ['2026-09-10', '2026-09-11'] },
    })
  })

  it('passes a lookup failure through as INTERNAL_ERROR', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const failure = await assertRegisterRangeUnlocked(supabase, COMPANY_ID, '2026-09-01', '2026-09-30')
    expect(failure).toEqual({ ok: false, code: 'INTERNAL_ERROR', details: { message: 'boom' } })
  })
})
