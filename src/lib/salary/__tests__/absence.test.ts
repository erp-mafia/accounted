/**
 * Unit tests for lib/salary/absence.ts (payroll gap-closure 1.4).
 *
 * Range expansion (weekend skipping, 92-day cap), natural-key upsert flow,
 * 24h-trigger mapping, range deletes with counts, and the register lock: a
 * run in review/approved/paid/booked that already read the dates refuses the
 * write (SALARY_REGISTER_DATES_LOCKED_BY_RUN), dry runs included.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  ABSENCE_RANGE_MAX_DAYS,
  deleteAbsenceRange,
  expandDateRange,
  listAbsenceDays,
  upsertAbsenceDay,
  upsertAbsenceRange,
} from '@/lib/salary/absence'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** March 2026 pay month, calculated, legacy NULL window: locks 2026-03-01..31. */
const REVIEW_RUN_MARCH = {
  id: 'run-mar',
  status: 'review',
  period_year: 2026,
  period_month: 3,
  deviation_period_start: null,
  deviation_period_end: null,
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

/** October 2026 pay month, booked, reading October: its days are settled. */
const BOOKED_RUN_OCTOBER = {
  id: 'run-oct',
  status: 'booked',
  period_year: 2026,
  period_month: 10,
  deviation_period_start: '2026-10-01',
  deviation_period_end: '2026-10-31',
  agi_submitted_at: null,
  corrects_run_id: null,
}

/** November 2026, a draft: the next run after October. */
const DRAFT_RUN_NOVEMBER = {
  id: 'run-nov',
  status: 'draft',
  period_year: 2026,
  period_month: 11,
  deviation_period_start: '2026-11-01',
  deviation_period_end: '2026-11-30',
  agi_submitted_at: null,
  corrects_run_id: null,
}

/**
 * The register-lock lookups every upsert makes right after the employee
 * check: the company's runs, then the days already registered on the key.
 */
const enqueueNoLockingRuns = () => {
  mock.enqueue({ data: [] })
  mock.enqueue({ data: [] })
}

/** The rows a range delete reaches, read before anything else: none. */
const enqueueNothingRegistered = () => mock.enqueue({ data: [] })

const fromCalls = () =>
  (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('expandDateRange', () => {
  it('expands an inclusive range and skips weekends by default', () => {
    // 2026-03-02 is a Monday; 2026-03-08 a Sunday.
    const days = expandDateRange('2026-03-02', '2026-03-08')
    expect(days).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ])
  })

  it('includes weekends when asked', () => {
    const days = expandDateRange('2026-03-06', '2026-03-08', { includeWeekends: true })
    expect(days).toEqual(['2026-03-06', '2026-03-07', '2026-03-08'])
  })

  it('handles a single day (from == to)', () => {
    expect(expandDateRange('2026-03-03', '2026-03-03')).toEqual(['2026-03-03'])
  })

  it('returns null for inverted ranges', () => {
    expect(expandDateRange('2026-03-08', '2026-03-02')).toBeNull()
  })

  it('returns null when the span exceeds the cap', () => {
    expect(expandDateRange('2026-01-01', '2026-06-30')).toBeNull()
    // Exactly at the cap is fine.
    expect(expandDateRange('2026-01-01', '2026-04-02')).not.toBeNull()
    expect(ABSENCE_RANGE_MAX_DAYS).toBe(92)
  })

  it('crosses DST transitions without dropping or duplicating days', () => {
    // Swedish DST switch on 2026-03-29: UTC-based math must stay per-day exact.
    const days = expandDateRange('2026-03-27', '2026-03-31', { includeWeekends: true })
    expect(days).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'])
  })
})

describe('upsertAbsenceRange', () => {
  it('returns EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mock.enqueue({ data: null })
    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-06',
      absenceType: 'sick',
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
  })

  it('returns ABSENCE_RANGE_TOO_LARGE beyond the cap', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-01-01',
      to: '2026-12-31',
      absenceType: 'sick',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ABSENCE_RANGE_TOO_LARGE')
  })

  it('bulk-upserts the expanded weekday rows in one statement', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({
      data: [
        { id: '1', absence_date: '2026-03-02', absence_type: 'sick', hours: 8, notes: null, salary_run_employee_id: null, created_at: '', updated_at: '' },
        { id: '2', absence_date: '2026-03-03', absence_type: 'sick', hours: 8, notes: null, salary_run_employee_id: null, created_at: '', updated_at: '' },
      ],
    })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-03',
      absenceType: 'sick',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.count).toBe(2)
    expect(fromCalls()).toEqual(['employees', 'salary_runs', 'salary_absence_days', 'salary_absence_days'])
    // A day no paid run read carries to no run.
    expect(mock.findCall('salary_absence_days', 'upsert')?.[0]).toEqual([
      expect.objectContaining({ absence_date: '2026-03-02', carried_to_run_id: null }),
      expect.objectContaining({ absence_date: '2026-03-03', carried_to_run_id: null }),
    ])
  })

  it('dry-run expands without touching salary_absence_days', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-06',
      absenceType: 'vab',
      hoursPerDay: 4,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.count).toBe(5)
      expect(result.data.days[0]).toEqual({
        absence_date: '2026-03-02',
        absence_type: 'vab',
        hours: 4,
        carried_to_run_id: null,
      })
    }
    expect(fromCalls()).toEqual(['employees', 'salary_runs', 'salary_absence_days'])
    expect(mock.findCall('salary_absence_days', 'upsert')).toBeUndefined()
  })

  it('refuses dates a run in review has already read (SALARY_REGISTER_DATES_LOCKED_BY_RUN) without writing', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [REVIEW_RUN_MARCH] })
    mock.enqueue({ data: [] })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-03',
      absenceType: 'sick',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
      expect(result.details).toEqual({
        salary_run_id: 'run-mar',
        status: 'review',
        period_year: 2026,
        period_month: 3,
        deviation_period_start: '2026-03-01',
        deviation_period_end: '2026-03-31',
        locked_dates: ['2026-03-02', '2026-03-03'],
        settled: false,
        reason: 'run_not_settled',
      })
    }
    expect(fromCalls()).toEqual(['employees', 'salary_runs', 'salary_absence_days'])
    expect(mock.findCall('salary_absence_days', 'upsert')).toBeUndefined()
  })

  it('reports the lock on a dry run too: that is what the preview is for', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [REVIEW_RUN_MARCH] })
    mock.enqueue({ data: [] })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-03',
      absenceType: 'sick',
      dryRun: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
  })

  it('does not lock dates outside every locking window', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [REVIEW_RUN_MARCH] })
    mock.enqueue({ data: [] })
    mock.enqueue({
      data: [
        { id: '1', absence_date: '2026-04-01', absence_type: 'sick', hours: 8, notes: null, salary_run_employee_id: null, created_at: '', updated_at: '' },
      ],
    })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-04-01',
      to: '2026-04-01',
      absenceType: 'sick',
    })

    expect(result.ok).toBe(true)
    expect(fromCalls()).toEqual(['employees', 'salary_runs', 'salary_absence_days', 'salary_absence_days'])
  })

  it('maps the 24h-cap trigger (23514) to ABSENCE_HOURS_CONFLICT', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({ data: null, error: { code: '23514', message: 'Total tid över 24h' } })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-02',
      absenceType: 'sick',
      hoursPerDay: 20,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ABSENCE_HOURS_CONFLICT')
  })

  it('maps a non-24h CHECK violation (23514) to VALIDATION_ERROR, not ABSENCE_HOURS_CONFLICT', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({
      data: null,
      error: {
        code: '23514',
        message:
          'new row for relation "salary_absence_days" violates check constraint "salary_absence_days_hours_check"',
      },
    })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-02',
      absenceType: 'sick',
      hoursPerDay: 30,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('maps an RLS/privilege denial (42501) to DB_PERMISSION_DENIED with the PG message in details', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({
      data: null,
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy for table "salary_absence_franvaro_audit"',
      },
    })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-02',
      absenceType: 'parental',
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

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-02',
      absenceType: 'sick',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR')
  })
})

describe('upsertAbsenceDay', () => {
  it('replaces the (date, type) row via an atomic upsert', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNoLockingRuns()
    mock.enqueue({
      data: {
        id: '1',
        absence_date: '2026-03-02',
        absence_type: 'sick',
        hours: 8,
        notes: null,
        salary_run_employee_id: null,
        created_at: '',
        updated_at: '',
      },
    })

    const result = await upsertAbsenceDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { absence_date: '2026-03-02', absence_type: 'sick', hours: 8 },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.absence_date).toBe('2026-03-02')
  })

  it('refuses a single day a calculated run has already read, without writing', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [REVIEW_RUN_MARCH] })
    mock.enqueue({ data: [] })

    const result = await upsertAbsenceDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { absence_date: '2026-03-02', absence_type: 'sick', hours: 8 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
      expect(result.details).toMatchObject({ salary_run_id: 'run-mar', locked_dates: ['2026-03-02'] })
    }
    expect(mock.findCall('salary_absence_days', 'upsert')).toBeUndefined()
  })
})

describe('listAbsenceDays / deleteAbsenceRange', () => {
  it('lists rows within the range', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({
      data: [
        { id: '1', absence_date: '2026-03-02', absence_type: 'sick', hours: 8, notes: null, salary_run_employee_id: null, created_at: '', updated_at: '' },
      ],
    })

    const result = await listAbsenceDays(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toHaveLength(1)
  })

  it('deletes a range and reports the count', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [{ absence_date: '2026-03-02', carried_to_run_id: null }] })
    enqueueNothingRegistered() // the company has no runs
    mock.enqueue({ data: null, count: 3 })

    const result = await deleteAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
      absenceType: 'sick',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.deleted_count).toBe(3)
  })

  it('dry-run delete counts without deleting', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNothingRegistered()
    mock.enqueue({ data: null, count: 2 })

    const result = await deleteAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.deleted_count).toBe(2)
  })

  it('refuses a range delete when a row in it was read by a calculated run, naming those dates', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({
      data: [
        { absence_date: '2026-03-30', carried_to_run_id: null },
        { absence_date: '2026-03-31', carried_to_run_id: null },
        { absence_date: '2026-04-01', carried_to_run_id: null },
      ],
    })
    mock.enqueue({ data: [REVIEW_RUN_MARCH] })

    const result = await deleteAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-30',
      to: '2026-04-02',
      absenceType: 'sick',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
      expect(result.details).toMatchObject({
        salary_run_id: 'run-mar',
        locked_dates: ['2026-03-30', '2026-03-31'],
      })
    }
    // Nothing was counted or deleted.
    expect(fromCalls()).toEqual(['employees', 'salary_absence_days', 'salary_runs'])
    expect(mock.findCall('salary_absence_days', 'delete')).toBeUndefined()
  })

  it('a range overlapping a locked window with nothing registered there deletes nothing and is not refused', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    enqueueNothingRegistered()
    mock.enqueue({ data: null, count: 0 })

    const result = await deleteAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-30',
      to: '2026-04-02',
    })

    expect(result).toEqual({ ok: true, data: { deleted_count: 0 } })
  })

  it('deletes a late day carried to a draft run although a booked run holds its date', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [{ absence_date: '2026-10-19', carried_to_run_id: 'run-nov' }] })
    mock.enqueue({ data: [BOOKED_RUN_OCTOBER, DRAFT_RUN_NOVEMBER] })
    mock.enqueue({ data: null, count: 1 })

    const result = await deleteAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-10-19',
      to: '2026-10-19',
      absenceType: 'parental',
    })

    expect(result).toEqual({ ok: true, data: { deleted_count: 1 } })
  })
})

describe('late days (absence known after its run was paid)', () => {
  it('refuses a new day a booked run read without a later run, and names the run it goes to', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_OCTOBER, DRAFT_RUN_NOVEMBER] })
    mock.enqueue({ data: [] })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-10-19',
      to: '2026-10-23',
      absenceType: 'parental',
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: {
        salary_run_id: 'run-oct',
        settled: true,
        reason: 'late_day_needs_later_run',
        locked_dates: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'],
        later_salary_run: { salary_run_id: 'run-nov', status: 'draft', period_year: 2026, period_month: 11 },
      },
    })
    expect(mock.findCall('salary_absence_days', 'upsert')).toBeUndefined()
  })

  it('registers the days on their real dates, carried to the next draft run', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_OCTOBER, DRAFT_RUN_NOVEMBER] })
    mock.enqueue({ data: [] }) // nothing registered on the days yet
    mock.enqueue({ data: { id: 'sre-nov' } }) // the employee is on November
    mock.enqueue({ data: [{ salary_run_id: 'run-oct', salary_type: 'monthly' }] }) // October paid the employee monthly
    mock.enqueue({ data: { salary_calculation_policy: {} } })
    mock.enqueue({
      data: [
        { id: '1', absence_date: '2026-10-29', absence_type: 'parental', hours: 8, notes: null, salary_run_employee_id: null, carried_to_run_id: 'run-nov', created_at: '', updated_at: '' },
        { id: '2', absence_date: '2026-10-30', absence_type: 'parental', hours: 8, notes: null, salary_run_employee_id: null, carried_to_run_id: 'run-nov', created_at: '', updated_at: '' },
      ],
    })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-10-29',
      to: '2026-10-30',
      absenceType: 'parental',
      carriedToRunId: 'run-nov',
    })

    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_absence_days', 'upsert')?.[0]).toEqual([
      expect.objectContaining({ absence_date: '2026-10-29', absence_type: 'parental', carried_to_run_id: 'run-nov' }),
      expect.objectContaining({ absence_date: '2026-10-30', absence_type: 'parental', carried_to_run_id: 'run-nov' }),
    ])
  })

  it('previews the late days with the run they go to', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_OCTOBER, DRAFT_RUN_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue({ data: [{ salary_run_id: 'run-oct', salary_type: 'monthly' }] })
    mock.enqueue({ data: { salary_calculation_policy: {} } })

    const result = await upsertAbsenceRange(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-10-30',
      to: '2026-11-02',
      absenceType: 'vab',
      carriedToRunId: 'run-nov',
      dryRun: true,
    })

    expect(result.ok && result.data.days).toEqual([
      { absence_date: '2026-10-30', absence_type: 'vab', hours: 8, carried_to_run_id: 'run-nov' },
      // November's own day: read by November's window, carried nowhere.
      { absence_date: '2026-11-02', absence_type: 'vab', hours: 8, carried_to_run_id: null },
    ])
    expect(mock.findCall('salary_absence_days', 'upsert')).toBeUndefined()
  })

  it('a single day keeps the carry it already has', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
    mock.enqueue({ data: [BOOKED_RUN_OCTOBER, DRAFT_RUN_NOVEMBER] })
    mock.enqueue({ data: [{ absence_date: '2026-10-30', carried_to_run_id: 'run-nov' }] })
    mock.enqueue({
      data: { id: '1', absence_date: '2026-10-30', absence_type: 'parental', hours: 4, notes: null, salary_run_employee_id: null, carried_to_run_id: 'run-nov', created_at: '', updated_at: '' },
    })

    const result = await upsertAbsenceDay(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      day: { absence_date: '2026-10-30', absence_type: 'parental', hours: 4 },
    })

    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_absence_days', 'upsert')?.[0]).toMatchObject({ carried_to_run_id: 'run-nov', hours: 4 })
  })
})
