/**
 * Unit tests for lib/salary/run-employees.ts (payroll gap-closure 1.3).
 *
 * Attach/remove employees on a draft salary run: draft gate, active-employee
 * check, duplicate 409, snapshot semantics, base-line seeding with roundOre.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { addEmployeeToRun, removeEmployeeFromRun } from '@/lib/salary/run-employees'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const MONTHLY_EMPLOYEE = {
  id: EMPLOYEE_ID,
  employment_degree: 80,
  monthly_salary: 35000,
  hourly_rate: null,
  salary_type: 'monthly',
  employment_type: 'employee',
  tax_table_number: 33,
  tax_column: 1,
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('addEmployeeToRun', () => {
  it('returns SALARY_RUN_NOT_FOUND for a missing run', async () => {
    mock.enqueue({ data: null })
    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
  })

  it('returns SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'approved' } })
    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_EMPLOYEES_NOT_DRAFT')
      expect(result.details).toEqual({ current_status: 'approved' })
    }
  })

  it('returns EMPLOYEE_NOT_FOUND for an inactive or unknown employee', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: null })
    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
  })

  it('returns SALARY_RUN_EMPLOYEE_DUPLICATE when already attached', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: MONTHLY_EMPLOYEE })
    mock.enqueue({ data: { id: SRE_ID } })
    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_EMPLOYEE_DUPLICATE')
  })

  it('attaches with a pay snapshot and seeds the base line (happy path)', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: MONTHLY_EMPLOYEE })
    mock.enqueue({ data: null }) // duplicate check: none
    mock.enqueue({
      data: {
        id: SRE_ID,
        salary_run_id: RUN_ID,
        employee_id: EMPLOYEE_ID,
        company_id: COMPANY_ID,
        employment_degree: 80,
        monthly_salary: 35000,
        salary_type: 'monthly',
        hours_worked: null,
        tax_table_number: 33,
        tax_column: 1,
        created_at: '2026-05-01T08:00:00Z',
        updated_at: '2026-05-01T08:00:00Z',
      },
    })
    mock.enqueue({ data: null }) // line insert

    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })

    expect(result.ok).toBe(true)
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual([
      'salary_runs',
      'employees',
      'salary_run_employees',
      'salary_run_employees',
      'salary_line_items',
    ])
  })

  it('dry-run returns the would-be snapshot without inserting', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: MONTHLY_EMPLOYEE })
    mock.enqueue({ data: null }) // duplicate check: none

    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.id).toBeNull()
      expect(result.data.employee_id).toBe(EMPLOYEE_ID)
      expect(result.data.employment_degree).toBe(80)
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    // Gate, employee lookup, duplicate check: no inserts.
    expect(fromCalls).toEqual(['salary_runs', 'employees', 'salary_run_employees'])
  })

  it('maps a 23505 insert race to SALARY_RUN_EMPLOYEE_DUPLICATE', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: MONTHLY_EMPLOYEE })
    mock.enqueue({ data: null }) // duplicate check passes...
    mock.enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } }) // ...but insert races

    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_EMPLOYEE_DUPLICATE')
  })
})

describe('removeEmployeeFromRun', () => {
  it('removes an attached employee from a draft run', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID } })
    mock.enqueue({ data: null }) // delete

    const result = await removeEmployeeFromRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.deleted).toBe(true)
  })

  it('returns SALARY_RUN_EMPLOYEE_NOT_FOUND when not attached', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: null })

    const result = await removeEmployeeFromRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' })
  })

  it('gates on draft status', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'booked' } })
    const result = await removeEmployeeFromRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_EMPLOYEES_NOT_DRAFT')
  })

  it('dry-run verifies without deleting', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID } })

    const result = await removeEmployeeFromRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees'])
  })
})
