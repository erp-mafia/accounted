/**
 * Unit tests for lib/salary/run-employees.ts (payroll gap-closure 1.3).
 *
 * Attach/remove employees on a draft salary run: draft gate, active-employee
 * check, duplicate 409, snapshot semantics, base-line seeding with roundOre.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  addEmployeeToRun,
  followEmployeeSalaryInDraftRuns,
  removeEmployeeFromRun,
  setRunEmployeeSalary,
} from '@/lib/salary/run-employees'

/** The rollout as the environment had it, restored after each test that sets it. */
const rolloutBefore = process.env.SALARY_EXTRA_RUNS_COMPANY_IDS

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

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

  it('gives an hourly employee no monthly salary on the run, even with one left on the employee (crm#1337)', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    // A monthly figure kept on the employee from before the switch to timlön.
    mock.enqueue({ data: { ...MONTHLY_EMPLOYEE, salary_type: 'hourly', monthly_salary: 28000, hourly_rate: 185 } })
    mock.enqueue({ data: null }) // duplicate check: none
    mock.enqueue({ data: { id: SRE_ID } })
    mock.enqueue({ data: null }) // line insert

    const result = await addEmployeeToRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 10,
    })

    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_run_employees', 'insert')?.[0]).toMatchObject({
      salary_type: 'hourly',
      monthly_salary: 0,
    })
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      item_type: 'hourly_salary',
      quantity: 10,
      unit_price: 185,
      amount: 1850,
    })
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

describe('followEmployeeSalaryInDraftRuns (crm#1337)', () => {
  const args = (
    previous: Record<string, unknown>,
    current: Record<string, unknown>,
  ) => ({ companyId: COMPANY_ID, employeeId: EMPLOYEE_ID, previous, current })
  const MONTHLY = { salary_type: 'monthly', monthly_salary: 30000, employment_degree: 80 }

  it('sets the new salary on draft rows still holding the old one, compare-and-set, and clears the calculation', async () => {
    mock.enqueue({ data: [{ id: RUN_ID }, { id: 'run-2' }] }) // draft runs
    mock.enqueue({ data: [{ id: SRE_ID }] }) // rows that followed
    mock.enqueue({ data: null }) // Grundlön line

    const result = await followEmployeeSalaryInDraftRuns(
      supabase,
      args(MONTHLY, { ...MONTHLY, monthly_salary: 32000 }),
    )

    expect(result).toEqual({ ok: true, data: { salary_run_employee_ids: [SRE_ID] } })
    expect(mock.findCalls('salary_runs', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['status', 'draft'],
    ])
    expect(mock.findCall('salary_run_employees', 'update')).toEqual([{ monthly_salary: 32000 }])
    expect(mock.findCalls('salary_run_employees', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['employee_id', EMPLOYEE_ID],
      ['salary_type', 'monthly'],
      // A row with any other figure had a salary typed in the run: kept.
      ['monthly_salary', 30000],
    ])
    expect(mock.findCall('salary_run_employees', 'in')).toEqual(['salary_run_id', [RUN_ID, 'run-2']])
    // The display line at the employee's degree, as the calculation prices it.
    expect(mock.findCall('salary_line_items', 'update')).toEqual([{ amount: 25600 }])
    expect(mock.findCall('salary_line_items', 'in')).toEqual(['salary_run_employee_id', [SRE_ID]])
  })

  it('touches no line when no draft row still held the old salary', async () => {
    mock.enqueue({ data: [{ id: RUN_ID }] })
    mock.enqueue({ data: [] })

    const result = await followEmployeeSalaryInDraftRuns(
      supabase,
      args(MONTHLY, { ...MONTHLY, monthly_salary: 32000 }),
    )

    expect(result).toEqual({ ok: true, data: { salary_run_employee_ids: [] } })
    expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
  })

  it('writes nothing without a draft run', async () => {
    mock.enqueue({ data: [] })

    await followEmployeeSalaryInDraftRuns(supabase, args(MONTHLY, { ...MONTHLY, monthly_salary: 32000 }))

    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
  })

  it('reads nothing for an unchanged salary or an employee paid hourly', async () => {
    await followEmployeeSalaryInDraftRuns(supabase, args(MONTHLY, { ...MONTHLY, employment_degree: 100 }))
    await followEmployeeSalaryInDraftRuns(
      supabase,
      args(MONTHLY, { salary_type: 'hourly', monthly_salary: 32000, employment_degree: 100 }),
    )

    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('reports a failed read without writing', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })

    const result = await followEmployeeSalaryInDraftRuns(
      supabase,
      args(MONTHLY, { ...MONTHLY, monthly_salary: 32000 }),
    )

    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
  })
})

describe('removeEmployeeFromRun', () => {
  it('removes an attached employee from a draft run', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID } })
    mock.enqueue({ data: [] }) // late absence days
    mock.enqueue({ data: [] }) // late worked days
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
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })

    const result = await removeEmployeeFromRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees', 'salary_absence_days', 'salary_worked_days'])
  })

  it.each([false, true])(
    'refuses while late days are carried to the run for the employee (dry run: %s): no run would deduct them',
    async (dryRun) => {
      mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
      mock.enqueue({ data: { id: SRE_ID } })
      mock.enqueue({ data: [{ absence_date: '2026-10-20' }, { absence_date: '2026-10-19' }] })
      mock.enqueue({ data: [{ work_date: '2026-10-21' }] })

      const result = await removeEmployeeFromRun(supabase, {
        companyId: COMPANY_ID,
        salaryRunId: RUN_ID,
        employeeId: EMPLOYEE_ID,
        dryRun,
      })

      expect(result).toEqual({
        ok: false,
        code: 'SALARY_RUN_EMPLOYEE_HAS_LATE_DAYS',
        details: { late_dates: ['2026-10-19', '2026-10-20', '2026-10-21'] },
      })
      expect(mock.findCall('salary_absence_days', 'in')).toEqual(['carried_to_run_id', [RUN_ID]])
      expect(mock.findCalls('salary_run_employees', 'delete')).toEqual([])
    },
  )

  it('a correction run also answers for the late days carried to the run it corrects', async () => {
    const ORIGINAL_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', corrects_run_id: ORIGINAL_ID } })
    mock.enqueue({ data: { id: SRE_ID } })
    mock.enqueue({ data: { id: ORIGINAL_ID, corrects_run_id: null } }) // the chain
    mock.enqueue({ data: [{ absence_date: '2026-10-20' }] })
    mock.enqueue({ data: [] })

    const result = await removeEmployeeFromRun(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
    })

    expect(result).toMatchObject({ ok: false, code: 'SALARY_RUN_EMPLOYEE_HAS_LATE_DAYS' })
    expect(mock.findCall('salary_absence_days', 'in')).toEqual(['carried_to_run_id', [RUN_ID, ORIGINAL_ID]])
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

  it('accepts monthly_salary when the employee moved to monthly pay after joining the draft run (agent feedback seq 869949)', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    // Snapshot says hourly (taken when the employee joined the run); the
    // employee is paid monthly now, which is what the calculation prices.
    mock.enqueue({
      data: {
        ...SRE_ROW,
        salary_type: 'hourly',
        monthly_salary: 0,
        hours_worked: null,
        employee: { salary_type: 'monthly', employment_type: 'employee' },
      },
    })
    mock.enqueue({ data: [{ id: 'li-old', item_type: 'hourly_salary' }] }) // base lines read
    mock.enqueue({ data: null }) // Grundlön line insert
    mock.enqueue({ data: null }) // stale Timlön line delete
    mock.enqueue({ data: null }) // snapshot salary_type refresh
    mock.enqueue({ data: null }) // sre monthly_salary update
    mock.enqueue({ data: null }) // Grundlön line amount update

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 30000,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.salary_type).toBe('monthly')
      expect(result.data.monthly_salary).toBe(30000)
    }
    const sreUpdates = mock.findCalls('salary_run_employees', 'update').map((a) => a[0])
    expect(sreUpdates).toEqual([
      { salary_type: 'monthly', monthly_salary: 30000 },
      { monthly_salary: 30000 },
    ])
    expect(mock.findCalls('salary_line_items', 'in').at(-1)).toEqual(['item_type', ['hourly_salary']])
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      item_type: 'monthly_salary',
      description: 'Grundlön',
      account_number: null,
    })
    // The new line is priced by the regular display refresh: 30 000 x 80 %.
    const lineUpdates = mock.findCalls('salary_line_items', 'update').map((a) => a[0])
    expect(lineUpdates).toEqual([{ amount: 24000 }])
  })

  it('a dry run checks against the live pay type without writing', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({
      data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: null, employee: { salary_type: 'monthly', employment_type: 'employee' } },
    })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      monthlySalary: 30000,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(mock.findCalls('salary_run_employees', 'update')).toHaveLength(0)
    expect(mock.findCalls('salary_line_items', 'insert')).toHaveLength(0)
  })

  it('still refuses hours on an employee who is paid monthly now, even with a stale hourly snapshot', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({
      data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: null, employee: { salary_type: 'monthly', employment_type: 'employee' } },
    })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 160,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_SALARY_FIELD_MISMATCH')
      expect(result.details).toEqual({ salary_type: 'monthly' })
    }
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

  it('refuses hours_worked on any calendar row, even one summing to zero hours', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({ data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: null } })
    mock.enqueue({ data: [{ hours: 0 }] })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 160,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_RUN_HOURS_FROM_CALENDAR')
      expect(result.details).toMatchObject({ calendar_hours: 0 })
    }
    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
  })

  it('checks calendar days in the run avvikelseperiod, not the pay month', async () => {
    mock.enqueue({
      data: {
        id: RUN_ID,
        status: 'draft',
        period_year: 2026,
        period_month: 6,
        deviation_period_start: '2026-05-01',
        deviation_period_end: '2026-05-31',
      },
    })
    mock.enqueue({ data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: null } })
    mock.enqueue({ data: [{ hours: 8 }] })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 160,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.details).toMatchObject({ period_start: '2026-05-01', period_end: '2026-05-31' })
    }
  })

  it('refuses hours_worked when the employee has no hourly rate, before any write', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 6 } })
    mock.enqueue({ data: { ...SRE_ROW, salary_type: 'hourly', hours_worked: null } })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { hourly_rate: null } })

    const result = await setRunEmployeeSalary(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      hoursWorked: 160,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_RUN_HOURLY_RATE_MISSING')
    expect(mock.findCall('salary_run_employees', 'update')).toBeUndefined()
    expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
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
    expect(mock.findCall('salary_run_employees', 'update')?.[0]).toEqual({ hours_worked: 160.33 })
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

describe('addEmployeeToRun: several runs in one month', () => {
  const OTHER_RUN = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    status: 'booked',
    period_year: 2026,
    period_month: 10,
    payment_date: '2026-11-05',
    run_number: 2,
    corrects_run_id: null,
  }
  const DRAFT = { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 11, payment_date: '2026-11-26', corrects_run_id: null }

  beforeEach(() => {
    process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = COMPANY_ID
  })

  afterEach(() => {
    if (rolloutBefore === undefined) delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    else process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = rolloutBefore
  })

  it('refuses an employee another run of the payout month already pays, naming that run', async () => {
    mock.enqueue({ data: DRAFT })
    mock.enqueue({ data: MONTHLY_EMPLOYEE })
    mock.enqueue({ data: null }) // not on this run
    mock.enqueue({ data: [OTHER_RUN] }) // the period's and payout month's other runs
    mock.enqueue({ data: [{ employee_id: EMPLOYEE_ID, salary_run_id: OTHER_RUN.id }] })

    const result = await addEmployeeToRun(supabase, { companyId: COMPANY_ID, salaryRunId: RUN_ID, employeeId: EMPLOYEE_ID })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_RUN_EMPLOYEE_IN_OTHER_RUN',
      details: {
        employee_ids: [EMPLOYEE_ID],
        other_salary_run_id: OTHER_RUN.id,
        other_run_period: '2026-10',
        other_run_number: 2,
        other_payment_date: '2026-11-05',
      },
    })
    expect(mock.findCall('salary_run_employees', 'insert')).toBeUndefined()
  })

  it('attaches an employee no other run of the month has', async () => {
    mock.enqueue({ data: DRAFT })
    mock.enqueue({ data: MONTHLY_EMPLOYEE })
    mock.enqueue({ data: null })
    mock.enqueue({ data: [OTHER_RUN] })
    mock.enqueue({ data: [] }) // the other run pays someone else
    mock.enqueue({ data: { id: SRE_ID } }) // salary_run_employees insert
    mock.enqueue({ data: null }) // base line insert

    const result = await addEmployeeToRun(supabase, { companyId: COMPANY_ID, salaryRunId: RUN_ID, employeeId: EMPLOYEE_ID })

    expect(result.ok).toBe(true)
  })
})
