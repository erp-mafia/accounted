/**
 * Unit tests for lib/salary/worked-days.ts.
 *
 * Range span helper, natural-key bulk upsert (one statement, onConflict on
 * the unique index), single-day replace, 24h-trigger mapping, range deletes
 * with counts, and the register lock: a run in review/approved/paid/booked
 * that already read the dates refuses the write
 * (SALARY_REGISTER_DATES_LOCKED_BY_RUN), dry runs included.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  WORKED_DAYS_RANGE_MAX_DAYS,
  assertWorkedDaysEmployee,
  deleteWorkedDaysRange,
  listWorkedDays,
  mapWorkedDaysWriteError,
  replaceWorkedDay,
  upsertWorkedDays,
  workedDaysRangeSpan,
} from '@/lib/salary/worked-days'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  work_date: '2026-03-02',
  hours: 8,
  start_time: '22:00:00',
  end_time: '06:00:00',
  notes: null,
  salary_run_employee_id: null,
  created_at: '2026-03-02T00:00:00Z',
  updated_at: '2026-03-02T00:00:00Z',
}

/** April 2026 pay month, booked, reading March ("previous_month"): locks 2026-03-01..31 only. */
const BOOKED_RUN_APRIL_READS_MARCH = {
  id: 'run-apr',
  status: 'booked',
  period_year: 2026,
  period_month: 4,
  deviation_period_start: '2026-03-01',
  deviation_period_end: '2026-03-31',
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

/** The register-lock lookup every write makes right after the employee check. */
const enqueueNoLockingRuns = () => mock.enqueue({ data: [] })

const fromCalls = () =>
  (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('workedDaysRangeSpan', () => {
  it('counts inclusive days', () => {
    expect(workedDaysRangeSpan('2026-03-02', '2026-03-02')).toBe(1)
    expect(workedDaysRangeSpan('2026-03-01', '2026-03-31')).toBe(31)
  })

  it('returns null for inverted or unparseable ranges', () => {
    expect(workedDaysRangeSpan('2026-03-08', '2026-03-02')).toBeNull()
    expect(workedDaysRangeSpan('not-a-date', '2026-03-02')).toBeNull()
  })

  it('crosses DST transitions without drift', () => {
    // Swedish DST switch on 2026-03-29: UTC-based math must stay per-day exact.
    expect(workedDaysRangeSpan('2026-03-27', '2026-03-31')).toBe(5)
  })

  it('caps at one quarter plus buffer', () => {
    expect(WORKED_DAYS_RANGE_MAX_DAYS).toBe(92)
    expect(workedDaysRangeSpan('2026-01-01', '2026-04-02')).toBe(92)
    expect(workedDaysRangeSpan('2026-01-01', '2026-04-03')).toBe(93)
  })
})

describe('mapWorkedDaysWriteError', () => {
  it('maps the 24h-cap trigger text to WORKED_HOURS_CONFLICT', () => {
    const mapped = mapWorkedDaysWriteError({
      code: '23514',
      message: 'Total tid (arbete + frånvaro) för 2026-03-02 får inte överstiga 24 timmar',
    })
    expect(mapped.code).toBe('WORKED_HOURS_CONFLICT')
    expect(mapped.details).toEqual({
      message: 'Total tid (arbete + frånvaro) för 2026-03-02 får inte överstiga 24 timmar',
      pg_code: '23514',
    })
  })

  it('maps any other CHECK violation to VALIDATION_ERROR', () => {
    const mapped = mapWorkedDaysWriteError({
      code: '23514',
      message: 'new row for relation "salary_worked_days" violates check constraint "salary_worked_days_hours_check"',
    })
    expect(mapped.code).toBe('VALIDATION_ERROR')
  })

  it('maps an RLS/privilege denial to DB_PERMISSION_DENIED', () => {
    expect(mapWorkedDaysWriteError({ code: '42501', message: 'permission denied' }).code).toBe(
      'DB_PERMISSION_DENIED',
    )
  })

  it('keeps unknown errors as INTERNAL_ERROR', () => {
    expect(mapWorkedDaysWriteError({ code: '57014', message: 'statement timeout' }).code).toBe(
      'INTERNAL_ERROR',
    )
  })
})

describe('assertWorkedDaysEmployee', () => {
  it('scopes the lookup to the company and returns the id', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    const result = await assertWorkedDaysEmployee(supabase, COMPANY_ID, EMPLOYEE_ID)
    expect(result).toEqual({ ok: true, data: { id: EMPLOYEE_ID } })
    const eqCalls = mock.findCalls('employees', 'eq')
    expect(eqCalls).toContainEqual(['id', EMPLOYEE_ID])
    expect(eqCalls).toContainEqual(['company_id', COMPANY_ID])
  })

  it('returns EMPLOYEE_NOT_FOUND when the employee is in another company', async () => {
    mock.enqueue({ data: null })
    const result = await assertWorkedDaysEmployee(supabase, COMPANY_ID, EMPLOYEE_ID)
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
  })
})

describe('listWorkedDays', () => {
  it('returns EMPLOYEE_NOT_FOUND without querying the register', async () => {
    mock.enqueue({ data: null })
    const result = await listWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(fromCalls()).toEqual(['employees'])
  })

  it('lists rows within the range, including the shift window', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [ROW] })

    const result = await listWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toHaveLength(1)
      expect(result.data[0].start_time).toBe('22:00:00')
    }
    const selected = mock.findCall('salary_worked_days', 'select')?.[0] as string
    expect(selected).toContain('start_time')
    expect(selected).toContain('end_time')
    expect(mock.findCall('salary_worked_days', 'gte')).toEqual(['work_date', '2026-03-01'])
    expect(mock.findCall('salary_worked_days', 'lte')).toEqual(['work_date', '2026-03-31'])
    expect(mock.findCalls('salary_worked_days', 'eq')).toContainEqual(['company_id', COMPANY_ID])
  })

  it('maps a read failure to INTERNAL_ERROR with the pg message', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: null, error: { code: '57014', message: 'statement timeout' } })

    const result = await listWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INTERNAL_ERROR')
      expect(result.details).toEqual({ message: 'statement timeout', pg_code: '57014' })
    }
  })
})

describe('upsertWorkedDays', () => {
  const days = [
    { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00' },
    { work_date: '2026-03-03', hours: 4, notes: 'Halvdag' },
  ]

  it('returns EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mock.enqueue({ data: null })
    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days,
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
  })

  it('bulk-upserts every day in one statement on the unique index', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: [ROW, { ...ROW, id: '22222222-2222-4222-8222-222222222222', work_date: '2026-03-03', hours: 4 }] })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.count).toBe(2)
      expect(result.data.days).toHaveLength(2)
    }
    expect(fromCalls()).toEqual(['employees', 'salary_runs', 'salary_worked_days'])

    const upsert = mock.findCall('salary_worked_days', 'upsert')
    expect(upsert).toBeDefined()
    const [rows, options] = upsert as [Array<Record<string, unknown>>, { onConflict: string }]
    expect(options).toEqual({ onConflict: 'employee_id,work_date' })
    expect(rows).toEqual([
      {
        company_id: COMPANY_ID,
        employee_id: EMPLOYEE_ID,
        work_date: '2026-03-02',
        hours: 8,
        notes: null,
        salary_run_employee_id: null,
        start_time: '22:00',
        end_time: '06:00',
      },
      {
        company_id: COMPANY_ID,
        employee_id: EMPLOYEE_ID,
        work_date: '2026-03-03',
        hours: 4,
        notes: 'Halvdag',
        salary_run_employee_id: null,
        start_time: null,
        end_time: null,
      },
    ])
    // Never a delete or a per-row insert: the upsert is the whole write.
    expect(mock.findCall('salary_worked_days', 'delete')).toBeUndefined()
    expect(mock.findCall('salary_worked_days', 'insert')).toBeUndefined()
  })

  it('dry-run echoes the would-be rows without touching salary_worked_days', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.count).toBe(2)
      expect(result.data.days[0]).toEqual({
        work_date: '2026-03-02',
        hours: 8,
        start_time: '22:00',
        end_time: '06:00',
        notes: null,
      })
    }
    expect(fromCalls()).toEqual(['employees', 'salary_runs'])
  })

  it('refuses dates a booked run has already read through its stored window, without writing', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_APRIL_READS_MARCH] })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [
        { work_date: '2026-03-31', hours: 8 },
        { work_date: '2026-04-01', hours: 8 },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
      expect(result.details).toEqual({
        salary_run_id: 'run-apr',
        status: 'booked',
        period_year: 2026,
        period_month: 4,
        deviation_period_start: '2026-03-01',
        deviation_period_end: '2026-03-31',
        locked_dates: ['2026-03-31'],
      })
    }
    expect(fromCalls()).toEqual(['employees', 'salary_runs'])
  })

  it('reports the lock on a dry run too: that is what the preview is for', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_APRIL_READS_MARCH] })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [{ work_date: '2026-03-02', hours: 8 }],
      dryRun: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
  })

  it('does not lock the pay month of a run whose stored window is the month before', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_APRIL_READS_MARCH] })
    mock.enqueue({ data: [{ ...ROW, work_date: '2026-04-01' }] })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [{ work_date: '2026-04-01', hours: 8 }],
    })

    expect(result.ok).toBe(true)
    expect(fromCalls()).toEqual(['employees', 'salary_runs', 'salary_worked_days'])
  })

  it('returns count 0 and skips the write for an empty list', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [],
    })
    expect(result).toEqual({ ok: true, data: { count: 0, days: [] } })
    expect(fromCalls()).toEqual(['employees'])
  })

  it('rejects more than the cap with WORKED_DAYS_RANGE_TOO_LARGE', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    const tooMany = Array.from({ length: WORKED_DAYS_RANGE_MAX_DAYS + 1 }, (_, i) => ({
      work_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      hours: 8,
    }))

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: tooMany,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('WORKED_DAYS_RANGE_TOO_LARGE')
      expect(result.details?.max_days).toBe(92)
    }
    expect(fromCalls()).toEqual(['employees'])
  })

  it('rejects a duplicate work_date with VALIDATION_ERROR before writing', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [
        { work_date: '2026-03-02', hours: 8 },
        { work_date: '2026-03-03', hours: 8 },
        { work_date: '2026-03-02', hours: 4 },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR')
      expect(result.details?.duplicate_dates).toEqual(['2026-03-02'])
    }
    expect(fromCalls()).toEqual(['employees'])
  })

  it('maps the 24h-cap trigger (23514, "Total tid") to WORKED_HOURS_CONFLICT', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({
      data: null,
      error: { code: '23514', message: 'Total tid (arbete + frånvaro) för 2026-03-02 får inte överstiga 24 timmar' },
    })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [{ work_date: '2026-03-02', hours: 20 }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('WORKED_HOURS_CONFLICT')
      expect(result.details?.message).toMatch(/Total tid/)
    }
  })

  it('maps a non-24h CHECK violation (23514) to VALIDATION_ERROR', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({
      data: null,
      error: {
        code: '23514',
        message: 'new row for relation "salary_worked_days" violates check constraint "salary_worked_days_hours_check"',
      },
    })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [{ work_date: '2026-03-02', hours: 30 }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('maps an RLS/privilege denial (42501) to DB_PERMISSION_DENIED', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy for table "salary_worked_days"' },
    })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [{ work_date: '2026-03-02', hours: 8 }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('DB_PERMISSION_DENIED')
      expect(result.details?.message).toMatch(/row-level security/)
    }
  })

  it('keeps unrecognized DB errors as INTERNAL_ERROR', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const result = await upsertWorkedDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      days: [{ work_date: '2026-03-02', hours: 8 }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })
})

describe('replaceWorkedDay', () => {
  it('deletes the day then inserts the full row, returning the stored row', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null }) // delete
    mock.enqueue({ data: ROW }) // insert ... select().single()

    const result = await replaceWorkedDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00' },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.id).toBe(ROW.id)
    expect(fromCalls()).toEqual(['employees', 'salary_runs', 'salary_worked_days', 'salary_worked_days'])
    expect(mock.findCall('salary_worked_days', 'delete')).toBeDefined()
    expect(mock.findCall('salary_worked_days', 'insert')?.[0]).toEqual({
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      work_date: '2026-03-02',
      hours: 8,
      notes: null,
      salary_run_employee_id: null,
      start_time: '22:00',
      end_time: '06:00',
    })
  })

  it('stores NULL times when the shift window is omitted', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null })
    mock.enqueue({ data: { ...ROW, start_time: null, end_time: null } })

    await replaceWorkedDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { work_date: '2026-03-02', hours: 8 },
    })

    expect(mock.findCall('salary_worked_days', 'insert')?.[0]).toMatchObject({
      start_time: null,
      end_time: null,
    })
  })

  it('maps the 24h-cap trigger on the insert to WORKED_HOURS_CONFLICT', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null })
    mock.enqueue({ data: null, error: { code: '23514', message: 'Total tid över 24h' } })

    const result = await replaceWorkedDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { work_date: '2026-03-02', hours: 20 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WORKED_HOURS_CONFLICT')
  })

  it('maps a failed delete to INTERNAL_ERROR and never inserts', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null, error: { code: '08006', message: 'connection reset' } })

    const result = await replaceWorkedDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { work_date: '2026-03-02', hours: 8 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
    expect(mock.findCall('salary_worked_days', 'insert')).toBeUndefined()
  })

  it('refuses a day a booked run has already read: neither delete nor insert runs', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_APRIL_READS_MARCH] })

    const result = await replaceWorkedDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { work_date: '2026-03-02', hours: 8 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
      expect(result.details).toMatchObject({ salary_run_id: 'run-apr', locked_dates: ['2026-03-02'] })
    }
    expect(fromCalls()).toEqual(['employees', 'salary_runs'])
    expect(mock.findCall('salary_worked_days', 'delete')).toBeUndefined()
    expect(mock.findCall('salary_worked_days', 'insert')).toBeUndefined()
  })
})

describe('deleteWorkedDaysRange', () => {
  it('deletes the range with company + employee filters and reports the count', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null, count: 3 })

    const result = await deleteWorkedDaysRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
    })

    expect(result).toEqual({ ok: true, data: { deleted_count: 3 } })
    expect(mock.findCall('salary_worked_days', 'delete')).toEqual([{ count: 'exact' }])
    expect(mock.findCalls('salary_worked_days', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['employee_id', EMPLOYEE_ID],
    ])
    expect(mock.findCall('salary_worked_days', 'gte')).toEqual(['work_date', '2026-03-01'])
    expect(mock.findCall('salary_worked_days', 'lte')).toEqual(['work_date', '2026-03-31'])
  })

  it('dry-run counts without deleting', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null, count: 2 })

    const result = await deleteWorkedDaysRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
      dryRun: true,
    })

    expect(result).toEqual({ ok: true, data: { deleted_count: 2 } })
    expect(mock.findCall('salary_worked_days', 'delete')).toBeUndefined()
    expect(mock.findCall('salary_worked_days', 'select')).toEqual(['id', { count: 'exact', head: true }])
  })

  it('returns EMPLOYEE_NOT_FOUND without deleting', async () => {
    mock.enqueue({ data: null })
    const result = await deleteWorkedDaysRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(fromCalls()).toEqual(['employees'])
  })

  it('refuses a range delete that overlaps a locked window, computed from the range in one query', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_APRIL_READS_MARCH] })

    const result = await deleteWorkedDaysRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-30',
      to: '2026-04-02',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
      expect(result.details).toMatchObject({
        salary_run_id: 'run-apr',
        locked_dates: ['2026-03-30', '2026-03-31'],
      })
    }
    expect(fromCalls()).toEqual(['employees', 'salary_runs'])
    expect(mock.findCall('salary_worked_days', 'delete')).toBeUndefined()
  })
})
