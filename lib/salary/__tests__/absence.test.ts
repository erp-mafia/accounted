/**
 * Unit tests for lib/salary/absence.ts (payroll gap-closure 1.4).
 *
 * Range expansion (weekend skipping, 92-day cap), natural-key upsert flow,
 * 24h-trigger mapping, and range deletes with counts.
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

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

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
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['employees', 'salary_absence_days'])
  })

  it('dry-run expands without touching salary_absence_days', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })

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
      })
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['employees'])
  })

  it('maps the 24h-cap trigger (23514) to ABSENCE_HOURS_CONFLICT', async () => {
    mock.enqueue({ data: { id: EMPLOYEE_ID } })
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
})
