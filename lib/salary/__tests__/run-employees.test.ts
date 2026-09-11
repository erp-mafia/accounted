/**
 * Unit tests for lib/salary/run-employees.ts (payroll gap-closure 1.3).
 *
 * Attach/remove employees on a draft salary run: draft gate, active-employee
 * check, duplicate 409, snapshot semantics, base-line seeding with roundOre.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { addEmployeeToRun, removeEmployeeFromRun, setRunEmployeeSalary } from '@/lib/salary/run-employees'

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

describe('setRunEmployeeSalary', () => {
  const SRE_ROW = {
    id: SRE_ID,
    employee_id: EMPLOYEE_ID,
    salary_type: 'monthly',
    employment_degree: 80,
    monthly_salary: 35000,
  }

  it('rejects a negative salary without touching the DB', async () => {
    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: -1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
    expect((mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('rejects a salary above SALARY_OVERRIDE_MAX without touching the DB', async () => {
    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 10_000_001,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
    expect((mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('rejects an overflow-scale salary (1e307) instead of writing Infinity', async () => {
    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 1e307,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('returns SALARY_RUN_NOT_FOUND for a missing run', async () => {
    mock.enqueue({ data: null })
    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 45000,
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
  })

  it('gates on draft status', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'review' } })
    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 45000,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_EMPLOYEES_NOT_DRAFT')
  })

  it('returns SALARY_RUN_EMPLOYEE_NOT_FOUND when the employee is not on the run', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: null })
    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 45000,
    })
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' })
  })

  it('updates the per-run salary and refreshes the display line (happy path)', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: SRE_ROW })
    mock.enqueue({ data: null }) // sre update
    mock.enqueue({ data: null }) // line update

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 45000.005,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.previous_monthly_salary).toBe(35000)
      expect(result.data.monthly_salary).toBe(45000.01) // roundOre applied
      expect(result.data.salary_run_employee_id).toBe(SRE_ID)
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual([
      'salary_runs',
      'salary_run_employees',
      'salary_run_employees',
      'salary_line_items',
    ])
  })

  it('accepts 0 as an intentional nollkörning', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: SRE_ROW })
    mock.enqueue({ data: null })
    mock.enqueue({ data: null })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 0,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.monthly_salary).toBe(0)
  })

  it('rejects monthly_salary on an hourly row without writing (the engine would ignore it)', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({ data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: null } })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 45000,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_SALARY_FIELD_MISMATCH')
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees'])
  })

  it('rejects hours_worked on a monthly row', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({ data: { ...SRE_ROW, hours_worked: null } })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 160,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_SALARY_FIELD_MISMATCH')
  })

  it('rejects both fields, neither field and out-of-range hours without touching the DB', async () => {
    const base = { companyId: COMPANY_ID, salaryRunId: RUN_ID, employeeId: EMPLOYEE_ID }
    const both = await setRunEmployeeSalary(supabase, { ...base, monthlySalary: 1000, hoursWorked: 10 })
    const neither = await setRunEmployeeSalary(supabase, { ...base })
    const tooMany = await setRunEmployeeSalary(supabase, { ...base, hoursWorked: 745 })
    const negative = await setRunEmployeeSalary(supabase, { ...base, hoursWorked: -1 })
    for (const r of [both, neither, tooMany, negative]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('VALIDATION_ERROR')
    }
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('refuses hours_worked when the period already has calendar days (they win at calculation)', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({ data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: null } })
    mock.enqueue({ data: [{ hours: 8 }, { hours: '7.5' }] }) // salary_worked_days in period

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 160,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_HOURS_FROM_CALENDAR')
      expect(result.details).toMatchObject({
        calendar_hours: 15.5,
        period_start: '2026-06-01',
        period_end: '2026-06-30',
      })
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees', 'salary_worked_days'])
  })

  it('sets hours_worked on an hourly row and reprices the Timlön display line', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({ data: { ...SRE_ROW, salary_type: 'hourly', monthly_salary: 0, hours_worked: null } })
    mock.enqueue({ data: [] }) // no calendar days
    mock.enqueue({ data: { hourly_rate: 210.5 } }) // employees.hourly_rate
    mock.enqueue({ data: null }) // sre update
    mock.enqueue({ data: null }) // hourly_salary line update

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 160.333,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.previous_hours_worked).toBeNull()
      expect(result.data.hours_worked).toBe(160.33)
      expect(result.data.hourly_rate).toBe(210.5)
      expect(result.data.monthly_salary).toBe(0)
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual([
      'salary_runs',
      'salary_run_employees',
      'salary_worked_days',
      'employees',
      'salary_run_employees',
      'salary_line_items',
    ])
    expect(mock.findCall('salary_run_employees', 'update')?.[0]).toEqual({
      hours_worked: 160.33,
      calculation_breakdown: null,
    })
    expect(mock.findCall('salary_line_items', 'update')?.[0]).toEqual({
      amount: 33749.47,
      quantity: 160.33,
      unit_price: 210.5,
    })
  })

  it('dry-run for hours resolves the change without writing', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({ data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: 120, monthly_salary: 0 } })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { hourly_rate: 200 } })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 150,
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.previous_hours_worked).toBe(120)
      expect(result.data.hours_worked).toBe(150)
    }
    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
  })

  it('dry-run resolves old and new salary without writing', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: SRE_ROW })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 45000,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.previous_monthly_salary).toBe(35000)
      expect(result.data.monthly_salary).toBe(45000)
    }
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees'])
  })
})
