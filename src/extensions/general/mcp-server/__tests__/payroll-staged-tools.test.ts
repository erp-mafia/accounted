/**
 * Staging tests for the payroll write MCP tools (payroll gap-closure 1.7):
 * gnubok_update_payslip_line + gnubok_register_absence.
 *
 * Both STAGE a pending_operation (no direct writes); the executors in
 * lib/pending-operations/commit.ts are covered separately in
 * lib/pending-operations/__tests__/payroll-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockPreviewClose = vi.fn()
vi.mock('@/lib/salary/semesterberedning', () => ({
  previewVacationYearClose: (...a: unknown[]) => mockPreviewClose(...a),
  commitVacationYearClose: vi.fn(),
}))

import { tools } from '../server'
import { decryptPersonnummer } from '@/lib/salary/personnummer'

const updatePayslipLine = tools.find((t) => t.name === 'gnubok_update_payslip_line')!
const setRunSalary = tools.find((t) => t.name === 'gnubok_set_run_salary')!
const updateSalaryRun = tools.find((t) => t.name === 'gnubok_update_salary_run')!
const registerAbsence = tools.find((t) => t.name === 'gnubok_register_absence')!
const bookSalaryRun = tools.find((t) => t.name === 'gnubok_book_salary_run')!
const deleteAbsence = tools.find((t) => t.name === 'gnubok_delete_absence')!
const createEmployee = tools.find((t) => t.name === 'gnubok_create_employee')!
const updateEmployee = tools.find((t) => t.name === 'gnubok_update_employee')!
const setOpeningBalances = tools.find((t) => t.name === 'gnubok_set_employee_opening_balances')!
const closeVacationYear = tools.find((t) => t.name === 'gnubok_close_vacation_year')!

// Synthetic fixture personnummer (year 1900, a zero suffix with a valid check digit: staging runs the Luhn check).
const SAMPLE_PERSONNUMMER = '190001010008'

/** Flexible per-table mock that also captures insert payloads, so tests can
 * assert what stagePendingOperation persisted to pending_operations. */
function makeCapturingSupabase(byTable: Record<string, { data?: unknown; error?: unknown } | Array<{ data?: unknown; error?: unknown }>>) {
  const queues = new Map<string, Array<{ data?: unknown; error?: unknown }>>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const inserts: Record<string, unknown[]> = {}
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve({ count: null, ...next })
          }
        }
        return (...callArgs: unknown[]) => {
          if (prop === 'insert') {
            ;(inserts[table] ??= []).push(callArgs[0])
          }
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { inserts, from: vi.fn((table: string) => buildChain(table)) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_update_payslip_line', () => {
  const LINE_ROW = {
    id: 'line-1',
    salary_run_employee_id: 'sre-1',
    company_id: 'company-1',
    item_type: 'bonus',
    description: 'Kvartalsbonus',
    quantity: null,
    unit_price: null,
    amount: 5000,
    is_taxable: true,
    is_avgift_basis: true,
    is_vacation_basis: true,
    is_gross_deduction: false,
    is_net_deduction: false,
    account_number: '7210',
    sort_order: 0,
    created_at: '',
    updated_at: '',
    salary_run_employee: { salary_run_id: 'run-1' },
  }

  it('stages with a merged preview and a recalculate next-hint', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft' } }) // service draft gate
    enqueue({ data: LINE_ROW }) // service loadLineInRun (dry-run preflight)
    enqueue({ data: { payment_date: '2026-03-25' } }) // run payment_date for period check
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await updatePayslipLine.execute(
      { salary_run_id: 'run-1', salary_line_item_id: 'line-1', amount: 5500 },
      'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
    )) as {
      staged: boolean
      risk_level: string
      preview: Record<string, unknown>
      next?: { tool: string }
    }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.new_amount).toBe(5500)
    expect(result.preview.salary_line_item_id).toBe('line-1')
    expect(result.next?.tool).toBe('gnubok_calculate_salary_run')
  })

  it('throws when the run has advanced past draft (preflight)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'booked' } })

    await expect(
      updatePayslipLine.execute(
        { salary_run_id: 'run-1', salary_line_item_id: 'line-1', amount: 5500 },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/SALARY_RUN_LINE_NOT_DRAFT/)
  })

  it('rejects an empty patch', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      updatePayslipLine.execute(
        { salary_run_id: 'run-1', salary_line_item_id: 'line-1' },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/At least one/)
  })
})

describe('gnubok_set_run_salary', () => {
  const SRE_ROW = {
    id: 'sre-1',
    employee_id: 'emp-1',
    salary_type: 'monthly',
    employment_degree: 100,
    monthly_salary: 30000,
  }

  it('stages with old/new salary preview and a recalculate next-hint', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft' } }) // service draft gate (dry-run preflight)
    enqueue({ data: SRE_ROW }) // service sre lookup
    enqueue({ data: { payment_date: '2026-03-25', period_year: 2026, period_month: 3 } }) // run for period check
    enqueue({ data: { first_name: 'Anna', last_name: 'Andersson' } }) // name for preview
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await setRunSalary.execute(
      { salary_run_id: 'run-1', employee_id: 'emp-1', monthly_salary: 45000 },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as {
      staged: boolean
      risk_level: string
      preview: Record<string, unknown>
      next?: { tool: string }
    }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.previous_monthly_salary).toBe(30000)
    expect(result.preview.new_monthly_salary).toBe(45000)
    expect(result.preview.employee_name).toBe('Anna Andersson')
    expect(result.next?.tool).toBe('gnubok_calculate_salary_run')
  })

  it('throws when the run has advanced past draft (preflight)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'review' } })

    await expect(
      setRunSalary.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-1', monthly_salary: 45000 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_RUN_EMPLOYEES_NOT_DRAFT/)
  })

  it('rejects a negative salary', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      setRunSalary.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-1', monthly_salary: -100 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/monthly_salary/)
  })
})

describe('gnubok_set_run_salary: hours_worked', () => {
  const HOURLY_SRE = {
    id: 'sre-2',
    employee_id: 'emp-2',
    salary_type: 'hourly',
    employment_degree: 100,
    monthly_salary: 0,
    hours_worked: null,
  }

  it('stages hours for an hourly employee with an hours preview and hours-only params', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft', period_year: 2026, period_month: 3 } }) // draft gate
    enqueue({ data: HOURLY_SRE }) // sre lookup
    enqueue({ data: [] }) // no calendar days in the period
    enqueue({ data: { hourly_rate: 200 } }) // employees.hourly_rate
    enqueue({ data: { payment_date: '2026-03-25', period_year: 2026, period_month: 3 } }) // run for period check
    enqueue({ data: { first_name: 'Bo', last_name: 'Berg' } }) // name for preview
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-2' }, error: null }) // pending_operations insert

    const result = (await setRunSalary.execute(
      { salary_run_id: 'run-1', employee_id: 'emp-2', hours_worked: 160 },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as {
      staged: boolean
      preview: Record<string, unknown>
      next?: { tool: string }
    }

    expect(result.staged).toBe(true)
    const row = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(String(row.title)).toContain('timmar')
    expect(row.params).toEqual({ salary_run_id: 'run-1', employee_id: 'emp-2', hours_worked: 160 })
    expect(result.preview.previous_hours_worked).toBeNull()
    expect(result.preview.new_hours_worked).toBe(160)
    expect(result.preview.hourly_rate).toBe(200)
    expect(result.preview).not.toHaveProperty('new_monthly_salary')
    expect(result.next?.tool).toBe('gnubok_calculate_salary_run')
  })

  it('refuses hours when the period has calendar days (the calculation would discard them)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft', period_year: 2026, period_month: 3 } })
    enqueue({ data: HOURLY_SRE })
    enqueue({ data: [{ hours: 8 }] })

    await expect(
      setRunSalary.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-2', hours_worked: 160 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_RUN_HOURS_FROM_CALENDAR/)
  })

  it('rejects hours on a monthly employee and a salary on an hourly one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft', period_year: 2026, period_month: 3 } })
    enqueue({ data: { ...HOURLY_SRE, salary_type: 'monthly', monthly_salary: 30000 } })
    await expect(
      setRunSalary.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-2', hours_worked: 160 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_RUN_SALARY_FIELD_MISMATCH/)

    enqueue({ data: { id: 'run-1', status: 'draft', period_year: 2026, period_month: 3 } })
    enqueue({ data: HOURLY_SRE })
    await expect(
      setRunSalary.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-2', monthly_salary: 30000 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_RUN_SALARY_FIELD_MISMATCH/)
  })

  it('requires exactly one of monthly_salary and hours_worked before touching the run', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      setRunSalary.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-2' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/exactly one of monthly_salary or hours_worked/)
    await expect(
      setRunSalary.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-2', monthly_salary: 1, hours_worked: 1 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/exactly one of monthly_salary or hours_worked/)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('gnubok_update_salary_run', () => {
  const RUN_ROW = {
    id: 'run-1',
    status: 'draft',
    period_year: 2026,
    period_month: 3,
    payment_date: '2026-03-25',
    voucher_series: 'L',
    notes: null,
  }

  it('stages a payment_date change with old/new preview and a recalculate next-hint', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW }) // service draft gate + current values (dry-run preflight)
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await updateSalaryRun.execute(
      { salary_run_id: 'run-1', payment_date: '2026-03-23' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as {
      staged: boolean
      risk_level: string
      message: string
      preview: Record<string, unknown>
      next?: { tool: string }
    }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('low')
    expect((result.preview.previous as Record<string, unknown>).payment_date).toBe('2026-03-25')
    expect(result.preview.new_payment_date).toBe('2026-03-23')
    expect(result.preview.salary_run_id).toBe('run-1')
    expect(result.preview.invalidates_calculation).toBe(true)
    expect(result.next?.tool).toBe('gnubok_calculate_salary_run')
  })

  it('stages a notes-only change without the recalculate next-hint', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW }) // service draft gate (dry-run preflight)
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await updateSalaryRun.execute(
      { salary_run_id: 'run-1', notes: 'Extra utbetalning i mars' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown>; next?: { tool: string } }

    expect(result.staged).toBe(true)
    expect(result.preview.new_notes).toBe('Extra utbetalning i mars')
    expect(result.preview.invalidates_calculation).toBe(false)
    // Payment date untouched: no recalculation hint.
    expect(result.next).toBeUndefined()
  })

  it('throws when the run has advanced past draft (preflight)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...RUN_ROW, status: 'review' } })

    await expect(
      updateSalaryRun.execute(
        { salary_run_id: 'run-1', payment_date: '2026-03-23' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_RUN_PATCH_NOT_DRAFT/)
  })

  it('grandfathers day adjustments for a run whose current date is already outside the period', async () => {
    // Creation does not enforce the period coupling, so a legally created
    // out-of-period date must stay correctable within its own month.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...RUN_ROW, payment_date: '2026-04-05' } }) // period 2026-03, paid in April
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await updateSalaryRun.execute(
      { salary_run_id: 'run-1', payment_date: '2026-04-07' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.new_payment_date).toBe('2026-04-07')
  })

  it('stages a payment_date in the month after the period (lön i efterskott, #2191)', async () => {
    // The AGI redovisningsperiod follows payment_date, so a March run paid
    // in April is declared for April; no period guard refuses it.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW }) // draft gate passes; period is 2026-03
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await updateSalaryRun.execute(
      { salary_run_id: 'run-1', payment_date: '2026-04-05' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.new_payment_date).toBe('2026-04-05')
  })

  it('throws SALARY_RUN_NOT_FOUND for a foreign or unknown run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // company_id-scoped lookup misses: another tenant's run id looks identical
    // to a nonexistent one.
    enqueue({ data: null })

    await expect(
      updateSalaryRun.execute(
        { salary_run_id: 'run-foreign', payment_date: '2026-03-23' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_RUN_NOT_FOUND/)
  })

  it('rejects a malformed payment_date before touching the run, by code and naming the field', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateSalaryRun.execute(
        { salary_run_id: 'run-1', payment_date: '23/03/2026' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('payment_date') })
  })

  it('rejects a call with no updatable field', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateSalaryRun.execute(
        { salary_run_id: 'run-1' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/At least one of payment_date, voucher_series, notes/)
  })
})

describe('gnubok_register_absence', () => {
  it('stages with day-count preview and dateForPeriodCheck', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'emp-1' } }) // service assertEmployee (dry-run preflight)
    enqueue({ data: [] }) // register lock lookup: no locking runs
    enqueue({ data: { first_name: 'Anna', last_name: 'Andersson' } }) // name for title/preview
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-2' }, error: null }) // pending_operations insert

    const result = (await registerAbsence.execute(
      { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-06', absence_type: 'sick' },
      'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
    )) as {
      staged: boolean
      risk_level: string
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    // 2026-03-02 (Mon) .. 2026-03-06 (Fri) = 5 weekdays.
    expect(result.preview.day_count).toBe(5)
    expect(result.preview.employee_name).toBe('Anna Andersson')
    expect((result.preview.dates_sample as string[])[0]).toBe('2026-03-02')
  })

  it('throws for a range beyond the cap', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'emp-1' } })

    await expect(
      registerAbsence.execute(
        { employee_id: 'emp-1', from: '2026-01-01', to: '2026-12-31', absence_type: 'sick' },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/ABSENCE_RANGE_TOO_LARGE/)
  })

  it('throws for an unknown employee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      registerAbsence.execute(
        { employee_id: 'emp-x', from: '2026-03-02', to: '2026-03-06', absence_type: 'sick' },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/EMPLOYEE_NOT_FOUND/)
  })

  it('refuses to stage dates a calculated run already read: the dry-run preflight reports the lock', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'emp-1' } }) // service assertEmployee (dry-run preflight)
    enqueue({
      data: [
        { id: 'run-mar', status: 'review', period_year: 2026, period_month: 3, deviation_period_start: null, deviation_period_end: null },
      ],
    }) // register lock lookup: March is calculated

    await expect(
      registerAbsence.execute(
        { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-06', absence_type: 'sick' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_REGISTER_DATES_LOCKED_BY_RUN/)
    expect(findCalls('pending_operations', 'insert')).toHaveLength(0)
  })
})

describe('gnubok_book_salary_run', () => {
  const RUN_ROW = {
    id: 'run-1',
    status: 'review',
    period_year: 2026,
    period_month: 6,
    payment_date: '2026-06-25',
    total_gross: 30000,
    total_tax: 7000,
    total_net: 23000,
    total_avgifter: 9426,
  }

  const ROSTER_ROW = {
    id: 'sre-1',
    calculation_breakdown: { steps: [] },
    gross_salary: 30000,
    tax_withheld: 7000,
    tax_withheld_override: null,
    net_salary: 23000,
    avgifter_amount: 9426,
    avgifter_amount_override: null,
    vacation_accrual: 0,
    vacation_accrual_avgifter: 0,
    employee: { f_skatt_status: 'a_skatt' },
  }

  it('previews the effective totals: overrides set after the calculation are applied (agent feedback seq 948847)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW }) // salary_runs lookup (stored totals predate the override)
    enqueue({
      data: [{ ...ROSTER_ROW, tax_withheld_override: 0, avgifter_amount_override: 0 }],
    }) // roster preflight
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await bookSalaryRun.execute(
      { salary_run_id: 'run-1' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.total_tax).toBe(0)
    expect(result.preview.total_avgifter).toBe(0)
    expect(result.preview.total_net).toBe(30000)
    expect(result.preview.overrides_applied).toBe(true)
  })

  it('stages high-risk with a totals preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW }) // salary_runs lookup
    enqueue({ data: [ROSTER_ROW] }) // roster preflight
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await bookSalaryRun.execute(
      { salary_run_id: 'run-1' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(result.preview.period).toBe('2026-06')
    expect(result.preview.employee_count).toBe(1)
    expect(result.preview.total_net).toBe(23000)
    expect(result.preview.total_avgifter).toBe(9426)
    expect(result.preview.overrides_applied).toBe(false)
    expect(result.preview.current_status).toBe('review')
  })

  // crm#1216: the verifikat credits the net pay to the bank on payment_date,
  // so a date still ahead needs the user's word before anything is staged.
  it('refuses a payment date ahead without confirm_payment_date_ahead, staging nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...RUN_ROW, payment_date: '2999-12-31' } })

    const error = (await bookSalaryRun
      .execute({ salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'user' })
      .catch((err: unknown) => err)) as Error & { code?: string; remediation?: { args?: Record<string, unknown> } }

    expect(error.code).toBe('SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED')
    expect(error.message).toContain('2999-12-31')
    expect(error.remediation?.args).toEqual({ salary_run_id: 'run-1', confirm_payment_date_ahead: true })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages a confirmed early payout, carrying the confirmation and telling the approver', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...RUN_ROW, status: 'paid', payment_date: '2999-12-31' } })
    enqueue({ data: [ROSTER_ROW] }) // roster preflight
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await bookSalaryRun.execute(
      { salary_run_id: 'run-1', confirm_payment_date_ahead: true },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.warnings).toEqual([
      'Utbetalningsdagen 2999-12-31 har inte kommit än: nettolönen bokförs som utbetald från bankkontot den dagen.',
    ])
    const [row] = findCall('pending_operations', 'insert') as [{ params: Record<string, unknown> }]
    expect(row.params).toEqual({ salary_run_id: 'run-1', confirm_payment_date_ahead: true })
  })

  it('throws for an already-booked run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...RUN_ROW, status: 'booked' } })

    await expect(
      bookSalaryRun.execute(
        { salary_run_id: 'run-1' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/already booked/)
  })

  it('throws when the roster has uncalculated employees', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW })
    enqueue({ data: [{ id: 'sre-1', calculation_breakdown: null }] })

    await expect(
      bookSalaryRun.execute(
        { salary_run_id: 'run-1' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/lack a calculation/)
  })

  it('refuses an uncalculated roster with SALARY_RUN_NOT_CALCULATED, naming the employee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW })
    enqueue({
      data: [
        {
          ...ROSTER_ROW,
          employee_id: 'e1',
          calculation_breakdown: null,
          employee: { first_name: 'Anna', last_name: 'Svensson', f_skatt_status: 'a_skatt' },
        },
      ],
    })

    const error = (await bookSalaryRun
      .execute({ salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'user' })
      .catch((err: unknown) => err)) as Error & { code?: string }

    expect(error.code).toBe('SALARY_RUN_NOT_CALCULATED')
    expect(error.message).toContain('Anna Svensson')
  })

  it('refuses a draft that was never calculated, the review step\'s rule, even with no employees', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...RUN_ROW, status: 'draft', calculation_params: null } })
    enqueue({ data: [] })

    const error = (await bookSalaryRun
      .execute({ salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'user' })
      .catch((err: unknown) => err)) as Error & { code?: string }

    expect(error.code).toBe('SALARY_RUN_NOT_CALCULATED')
    expect(error.message).toContain('never been calculated')
  })

  it('shows the approver the warnings the approval will record: bank details for a payout, missing email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW })
    enqueue({
      data: [
        {
          ...ROSTER_ROW,
          employee_id: 'e1',
          employee: {
            first_name: 'Anna',
            last_name: 'Svensson',
            clearing_number: null,
            bank_account_number: null,
            email: null,
            f_skatt_status: 'a_skatt',
          },
        },
        {
          ...ROSTER_ROW,
          id: 'sre-2',
          employee_id: 'e2',
          net_salary: 0,
          tax_withheld: 0,
          employee: {
            first_name: 'Nils',
            last_name: 'Noll',
            clearing_number: null,
            bank_account_number: null,
            email: 'nils@example.se',
            f_skatt_status: 'a_skatt',
          },
        },
      ],
    })
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await bookSalaryRun.execute(
      { salary_run_id: 'run-1' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; preview: { warnings?: string[] } }

    expect(result.staged).toBe(true)
    const warnings = result.preview.warnings ?? []
    expect(warnings.some((w) => w.startsWith('Anna Svensson:') && /bank|clearing|konto/i.test(w))).toBe(true)
    expect(warnings).toContain('Anna Svensson: E-post saknas, lönebesked kan inte skickas')
    // Nothing to pay out, so no bank details needed (no payment-file line).
    expect(warnings.some((w) => w.startsWith('Nils Noll:'))).toBe(false)
  })
})

describe('gnubok_delete_absence', () => {
  it('stages with a deleted-day-count preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'emp-1' } }) // service assertEmployee (dry-run preflight)
    enqueue({ data: [] }) // register lock lookup: no locking runs
    enqueue({ data: null, count: 3 }) // dry-run count query
    enqueue({ data: { first_name: 'Anna', last_name: 'Andersson' } }) // name for title/preview
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-2' }, error: null }) // pending_operations insert

    const result = (await deleteAbsence.execute(
      { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-06', absence_type: 'sick' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.day_count).toBe(3)
    expect(result.preview.employee_name).toBe('Anna Andersson')
  })

  it('throws when the range contains nothing to delete', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'emp-1' } })
    enqueue({ data: [] }) // register lock lookup: no locking runs
    enqueue({ data: null, count: 0 })

    await expect(
      deleteAbsence.execute(
        { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-06' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/nothing to delete/)
  })
})

describe('gnubok_create_employee', () => {
  const validArgs = {
    first_name: 'Anna',
    last_name: 'Andersson',
    personnummer: SAMPLE_PERSONNUMMER,
    employment_start: '2026-01-15',
    salary_type: 'monthly',
    monthly_salary: 35000,
    tax_table_number: 33,
    tax_municipality: 'Stockholm',
  }

  it('encrypts personnummer at staging: params never carry the plaintext', async () => {
    const supabaseMock = makeCapturingSupabase({
      company_settings: { data: { entity_type: 'ab' } }, // entity-type preflight
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-3' }, error: null },
    })

    const result = (await createEmployee.execute(
      validArgs, 'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.personnummer_masked).toBe('19000101-XXXX')

    // The staged params must carry the ENCRYPTED value + last4, never the
    // raw personnummer: pending_operations is a persisted table.
    const inserted = supabaseMock.inserts.pending_operations?.[0] as {
      params: Record<string, unknown>
      title: string
      preview_data: Record<string, unknown>
    }
    expect(inserted).toBeDefined()
    expect(inserted.params.personnummer).toBeUndefined()
    expect(inserted.params.personnummer_last4).toBe('0008')
    expect(decryptPersonnummer(inserted.params.personnummer_encrypted as string)).toBe(SAMPLE_PERSONNUMMER)
    expect(JSON.stringify(inserted.params)).not.toContain(SAMPLE_PERSONNUMMER)
    expect(JSON.stringify(inserted.preview_data)).not.toContain(SAMPLE_PERSONNUMMER)
    expect(inserted.title).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('stages default_dimensions on the employee (free-text passthrough while dims are off)', async () => {
    const supabaseMock = makeCapturingSupabase({
      // Serves BOTH the dimensions resolver (dimensions_enabled undefined →
      // passthrough) and the entity-type preflight.
      company_settings: { data: { entity_type: 'ab' } },
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-dims-emp' }, error: null },
    })

    const result = (await createEmployee.execute(
      { ...validArgs, default_dimensions: { '1': 'KS1' } },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const inserted = supabaseMock.inserts.pending_operations?.[0] as {
      params: Record<string, unknown>
    }
    expect(inserted.params.default_dimensions).toEqual({ '1': 'KS1' })
  })

  it('stages personnel_category tjansteman by default and arbetare when asked', async () => {
    for (const [args, expected] of [
      [validArgs, 'tjansteman'],
      [{ ...validArgs, personnel_category: 'arbetare' }, 'arbetare'],
    ] as const) {
      const supabaseMock = makeCapturingSupabase({
        company_settings: { data: { entity_type: 'ab' } },
        fiscal_periods: { data: null },
        pending_operations: { data: { id: 'op-category' }, error: null },
      })

      const result = (await createEmployee.execute(
        args, 'company-1', 'user-1', supabaseMock as never, { type: 'user' },
      )) as { staged: boolean; preview: Record<string, unknown> }

      expect(result.staged).toBe(true)
      expect(result.preview.personnel_category).toBe(expected)
      const inserted = supabaseMock.inserts.pending_operations?.[0] as { params: Record<string, unknown> }
      expect(inserted.params.personnel_category).toBe(expected)
    }
  })

  it('rejects an unknown personnel_category', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createEmployee.execute(
        { ...validArgs, personnel_category: 'kollektiv' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/Invalid employee/)
  })

  it('advertises personnel_category as the two-value enum', () => {
    const props = (createEmployee.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
    expect(props.personnel_category.enum).toEqual(['arbetare', 'tjansteman'])
  })

  it('rejects invalid input via CreateEmployeeSchema (missing salary)', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createEmployee.execute(
        { ...validArgs, monthly_salary: undefined },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/Invalid employee/)
  })

  it('rejects a jämkning percentage without an end date (#2058)', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createEmployee.execute(
        { ...validArgs, jamkning_percentage: 15, jamkning_valid_from: '2026-01-01' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/jamkning_valid_to/)
  })

  it('stages a company owner with vacation_rule none and 0 vacation days (agent feedback seq 828138)', async () => {
    const supabaseMock = makeCapturingSupabase({
      company_settings: { data: { entity_type: 'ab' } },
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-owner' }, error: null },
    })

    const result = (await createEmployee.execute(
      { ...validArgs, employment_type: 'company_owner', vacation_rule: 'none', vacation_days_per_year: 0 },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const inserted = supabaseMock.inserts.pending_operations?.[0] as { params: Record<string, unknown> }
    expect(inserted.params.vacation_days_per_year).toBe(0)
  })

  it('rejects fewer than 25 vacation days under any other vacation rule', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createEmployee.execute(
        { ...validArgs, vacation_rule: 'procentregeln', vacation_days_per_year: 20 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/vacation_days_per_year/)
  })

  it('accepts and stages the address fields (agent feedback seq 828138)', async () => {
    expect(Object.keys(createEmployee.inputSchema.properties as object)).toEqual(
      expect.arrayContaining(['address_line1', 'postal_code', 'city']),
    )
    const supabaseMock = makeCapturingSupabase({
      company_settings: { data: { entity_type: 'ab' } },
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-addr' }, error: null },
    })

    await createEmployee.execute(
      { ...validArgs, address_line1: 'Testgatan 1', postal_code: '111 22', city: 'Teststad' },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )

    const inserted = supabaseMock.inserts.pending_operations?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toMatchObject({ address_line1: 'Testgatan 1', postal_code: '111 22', city: 'Teststad' })
  })

  it('blocks EF owners on payroll (entity-type preflight)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'ef' } }) // company_settings

    await expect(
      createEmployee.execute(
        { ...validArgs, employment_type: 'company_owner' },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow()
  })

  it('advertises only fields the create writes (door parity)', async () => {
    // Same check as on gnubok_update_employee: a key advertised here and
    // missing from the writable set would be dropped without a word.
    const { EMPLOYEE_CREATE_COLUMNS } = await import('@/lib/salary/employee-commands')
    const advertised = Object.keys((createEmployee.inputSchema as { properties: object }).properties)
    // personnummer is encrypted at staging and stored as its own pair.
    const dropped = advertised.filter((field) => field !== 'personnummer' && !EMPLOYEE_CREATE_COLUMNS.has(field))
    expect(dropped).toEqual([])
    // A new employee is active: the flag is an update-only key.
    expect(advertised).not.toContain('is_active')
  })
})

describe('gnubok_update_employee', () => {
  const EXISTING = {
    id: 'emp-1',
    first_name: 'Anna',
    last_name: 'Andersson',
    monthly_salary: 35000,
    clearing_number: '6000',
    bank_account_number: '12345678',
  }

  it('stages with a field-level changes preview and bank-change flag', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: EXISTING },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-4' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', monthly_salary: 38000, bank_account_number: '87654321' },
      'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
    )) as { staged: boolean; preview: { changes: Array<{ field: string; from: unknown; to: unknown }>; bank_details_changed: boolean } }

    expect(result.staged).toBe(true)
    expect(result.preview.bank_details_changed).toBe(true)
    const salaryChange = result.preview.changes.find((c) => c.field === 'monthly_salary')
    expect(salaryChange).toEqual({ field: 'monthly_salary', from: 35000, to: 38000 })
  })

  it('stages a personnel_category change with a from/to preview', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, personnel_category: 'tjansteman' } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-category-upd' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', personnel_category: 'arbetare' },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean; preview: { changes: Array<{ field: string; from: unknown; to: unknown }> } }

    expect(result.staged).toBe(true)
    expect(result.preview.changes).toContainEqual({ field: 'personnel_category', from: 'tjansteman', to: 'arbetare' })
    const inserted = supabaseMock.inserts.pending_operations?.[0] as { params: { patch: Record<string, unknown> } }
    expect(inserted.params.patch).toEqual({ personnel_category: 'arbetare' })
  })

  it('refuses null and unknown values for personnel_category at staging', async () => {
    for (const value of [null, 'kollektiv']) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: EXISTING })
      await expect(
        updateEmployee.execute(
          { employee_id: 'emp-1', personnel_category: value },
          'company-1', 'user-1', supabase as never, { type: 'user' },
        ),
      ).rejects.toThrow(/Invalid employee update/)
    }
  })

  it('stages a default_dimensions patch, with {} as the clear-all-tags update', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, default_dimensions: { '1': 'KS1' } } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-dims-emp2' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', default_dimensions: {} },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean; preview: { changes: Array<{ field: string; from: unknown; to: unknown }> } }

    expect(result.staged).toBe(true)
    const dimChange = result.preview.changes.find((c) => c.field === 'default_dimensions')
    expect(dimChange).toEqual({ field: 'default_dimensions', from: { '1': 'KS1' }, to: {} })
    const inserted = supabaseMock.inserts.pending_operations?.[0] as {
      params: { patch: Record<string, unknown> }
    }
    expect(inserted.params.patch.default_dimensions).toEqual({})
  })

  it('rejects a jämkning percentage without an end date at staging time (#2058)', async () => {
    // Preflight on the merged row: the agent gets the error now, not at
    // approval. The executor runs the same shared validator again.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EXISTING, jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null } })
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', jamkning_percentage: 15, jamkning_valid_from: '2026-01-01' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/jamkning_valid_to/)
  })

  it('stages a requested extra tax percentage', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, extra_tax_amount: null, extra_tax_percentage: null } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-extra-tax' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', extra_tax_percentage: 45 },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean; preview: { changes: Array<{ field: string; from: unknown; to: unknown }> } }

    expect(result.staged).toBe(true)
    expect(result.preview.changes).toContainEqual({ field: 'extra_tax_percentage', from: null, to: 45 })
  })

  it('refuses kronor sent while a percentage is stored, at staging time', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EXISTING, extra_tax_amount: null, extra_tax_percentage: 45 } })
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', extra_tax_amount: 500 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/extra_tax_percentage|kronor eller i procent/)
  })

  it('stages an unrelated edit on a legacy row that lacks valid_to (touched gate)', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, jamkning_percentage: 15, jamkning_valid_from: '2026-01-01', jamkning_valid_to: null } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-legacy' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', monthly_salary: 38000 },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
  })

  it('stages address fields, with null clearing one', async () => {
    expect(Object.keys(updateEmployee.inputSchema.properties as object)).toEqual(
      expect.arrayContaining(['address_line1', 'postal_code', 'city']),
    )
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, address_line1: null, postal_code: null, city: 'Gamla staden' } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-addr2' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', address_line1: 'Testgatan 1', postal_code: '111 22', city: null },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const inserted = supabaseMock.inserts.pending_operations?.[0] as { params: { patch: Record<string, unknown> } }
    expect(inserted.params.patch).toEqual({ address_line1: 'Testgatan 1', postal_code: '111 22', city: null })
  })

  it('lets an owner on vacation_rule none drop to 0 vacation days, and refuses it under another rule', async () => {
    const owner = makeCapturingSupabase({
      employees: { data: { ...EXISTING, vacation_rule: 'none', vacation_days_per_year: 25 } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-vac' }, error: null },
    })
    const ok = (await updateEmployee.execute(
      { employee_id: 'emp-1', vacation_days_per_year: 0 },
      'company-1', 'user-1', owner as never, { type: 'user' },
    )) as { staged: boolean }
    expect(ok.staged).toBe(true)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EXISTING, vacation_rule: 'procentregeln', vacation_days_per_year: 25 } })
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', vacation_days_per_year: 0 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/Invalid employee update/)
  })

  it('rejects personnummer changes at the tool boundary', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', personnummer: '190001029999' },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/immutable/)
  })

  it('throws for an unknown employee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-x', monthly_salary: 38000 },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/not found/i)
  })

  // The update contract shared with the dashboard and v1 PATCH (#3008):
  // null clears a nullable field, an omitted key is unchanged.
  it('stages a cleared slutdatum as an explicit null in the patch', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, employment_end: '2026-06-30' } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-clear-end' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', employment_end: null },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean; preview: { changes: Array<{ field: string; from: unknown; to: unknown }> } }

    expect(result.staged).toBe(true)
    expect(result.preview.changes).toEqual([{ field: 'employment_end', from: '2026-06-30', to: null }])
    const inserted = supabaseMock.inserts.pending_operations?.[0] as {
      params: { patch: Record<string, unknown> }
    }
    expect(inserted.params.patch).toEqual({ employment_end: null })
  })

  it('rejects null on a NOT NULL column at staging, with the same schema as the PATCH routes', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', employment_start: null },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/Invalid employee update: employment_start/)
  })

  it('rejects a malformed date at staging instead of at approval', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', employment_end: '30-06-2026' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/Invalid employee update: employment_end/)
  })

  it('rejects clearing the monthly salary of a monthly employee at staging (merged row)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EXISTING, salary_type: 'monthly' } })
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', monthly_salary: null },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/monthly_salary: Månadslön krävs/)
  })

  it('advertises only fields the update writes, and null exactly where UpdateEmployeeSchema accepts it (door parity)', async () => {
    const { UpdateEmployeeSchema } = await import('@/lib/api/schemas')
    const { EMPLOYEE_UPDATE_COLUMNS } = await import('@/lib/salary/employee-commands')
    const { EMPLOYEE_UPDATE_REQUEST_ONLY_KEYS } = await import('@/lib/salary/employee-update-rules')
    const properties = (updateEmployee.inputSchema as { properties: Record<string, { type?: unknown }> }).properties
    const mismatches: string[] = []
    // Advertised here, written nowhere. The schema strips a key it does not
    // know and the executor drops one outside its writable set, and neither
    // says so: is_active was advertised for months while this loop skipped
    // it as "not part of the update schema" (crm#1133).
    const dropped: string[] = []
    for (const [field, prop] of Object.entries(properties)) {
      // employee_id is the target of the update, not a column.
      if (field === 'employee_id') continue
      const zodField = UpdateEmployeeSchema.shape[field as keyof typeof UpdateEmployeeSchema.shape]
      // A request-only key is read by the update itself, not written.
      if (!zodField || !(EMPLOYEE_UPDATE_COLUMNS.has(field) || EMPLOYEE_UPDATE_REQUEST_ONLY_KEYS.has(field))) {
        dropped.push(field)
        continue
      }
      const advertisesNull = Array.isArray(prop.type) && prop.type.includes('null')
      if (advertisesNull !== zodField.safeParse(null).success) mismatches.push(field)
    }
    expect(dropped).toEqual([])
    expect(mismatches).toEqual([])
  })

  // Semesterlagen 16 § andra stycket 3-4 (#31): the executor's rule in dry
  // run refuses at staging, and the confirmation rides in the staged patch.
  it('refuses at staging a changed employment_degree that keeps sammalöneregeln', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EXISTING, vacation_rule: 'sammaloneregeln', employment_degree: 100 } })
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', employment_degree: 80 },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED/)
  })

  it('stages the change with the kollektivavtal confirmation in the patch the executor reads', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, vacation_rule: 'sammaloneregeln', employment_degree: 100 } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-sammalone' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', employment_degree: 80, sammaloneregeln_kollektivavtal_confirmed: true },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const inserted = supabaseMock.inserts.pending_operations?.[0] as { params: { patch: Record<string, unknown> } }
    expect(inserted.params.patch).toEqual({ employment_degree: 80, sammaloneregeln_kollektivavtal_confirmed: true })
  })

  it('stages a reactivation: is_active reaches the staged patch and the changes preview', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: { data: { ...EXISTING, is_active: false } },
      fiscal_periods: { data: null },
      company_settings: { data: null },
      pending_operations: { data: { id: 'op-reactivate' }, error: null },
    })

    const result = (await updateEmployee.execute(
      { employee_id: 'emp-1', is_active: true },
      'company-1', 'user-1', supabaseMock as never, { type: 'user' },
    )) as { staged: boolean; preview: { changes: Array<{ field: string; from: unknown; to: unknown }> } }

    expect(result.staged).toBe(true)
    expect(result.preview.changes).toEqual([{ field: 'is_active', from: false, to: true }])
    const inserted = supabaseMock.inserts.pending_operations?.[0] as { params: { patch: Record<string, unknown> } }
    expect(inserted.params.patch).toEqual({ is_active: true })
  })

  it('rejects a non-boolean is_active at staging instead of at approval', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      updateEmployee.execute(
        { employee_id: 'emp-1', is_active: null },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/Invalid employee update: is_active/)
  })
})

describe('gnubok_set_employee_opening_balances', () => {
  const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const CURRENT_YEAR = new Date().getFullYear()
  const validItem = {
    employee_id: EMPLOYEE_ID,
    cutover_date: `${CURRENT_YEAR}-07-01`,
    ytd_gross: 210000,
    ytd_tax: 48000,
    ytd_net: 162000,
    vacation_paid_days_remaining: 12.5,
    vacation_saved_days_by_year: { [`${CURRENT_YEAR - 1}`]: 5 },
    opening_semester_liability: 42000,
    opening_semester_liability_avgifter: 13196.4,
    karens_periods_adjustment: 1,
  }

  it('stages after preflighting the whole batch (happy path)', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: {
        data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
      },
      salary_run_employees: { data: [] },
      pending_operations: { data: { id: 'op-5' }, error: null },
    })

    const result = (await setOpeningBalances.execute(
      { items: [validItem] },
      'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('medium')
    expect(result.preview.employee_count).toBe(1)
    expect(result.preview.total_ytd_gross).toBe(210000)
    // The write table is never touched at staging.
    const inserted = supabaseMock.inserts.employee_opening_balances
    expect(inserted).toBeUndefined()
  })

  it('throws with the per-item error list when locked', async () => {
    const supabaseMock = makeCapturingSupabase({
      employees: {
        data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
      },
      salary_run_employees: {
        data: [{ employee_id: EMPLOYEE_ID, salary_run: { id: 'run-1', status: 'booked' } }],
      },
    })

    await expect(
      setOpeningBalances.execute(
        { items: [validItem] },
        'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/Locked by booked salary run/)
  })

  it('rejects invalid items via the shared Zod schema', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      setOpeningBalances.execute(
        { items: [{ ...validItem, cutover_date: `${CURRENT_YEAR}-07-15` }] },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/Invalid opening balances/)
  })

  // The tool advertises idempotentHint: true and only requires employee_id +
  // cutover_date, but every omitted field carries a Zod .default(). Without a
  // merge, correcting one YTD figure silently zeroes the other eight columns:
  // the semesterlöneskuld on 2920/2940 and the sparade dagar carried across
  // years are real balances, not blanks to be re-derived.
  const STORED_ROW = {
    employee_id: EMPLOYEE_ID,
    ytd_gross: 210000,
    ytd_tax: 48000,
    ytd_net: 162000,
    vacation_paid_days_remaining: 12.5,
    vacation_saved_days_by_year: { [`${CURRENT_YEAR - 1}`]: 5 },
    opening_semester_liability: 42000,
    opening_semester_liability_avgifter: 13196.4,
    karens_periods_adjustment: 1,
  }

  function mockWithStoredRow(stored: Record<string, unknown> | null) {
    return makeCapturingSupabase({
      employee_opening_balances: { data: stored ? [stored] : [] },
      employees: {
        data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
      },
      salary_run_employees: { data: [] },
      pending_operations: { data: { id: 'op-6' }, error: null },
    })
  }

  /** The items actually persisted to pending_operations.params. */
  function stagedItems(mock: { inserts: Record<string, unknown[]> }) {
    const insert = mock.inserts.pending_operations?.[0] as {
      params: { items: Array<Record<string, unknown>> }
    }
    return insert.params.items
  }

  it('correcting one YTD figure leaves the other eight fields untouched', async () => {
    const supabaseMock = mockWithStoredRow(STORED_ROW)

    const result = (await setOpeningBalances.execute(
      {
        items: [
          {
            employee_id: EMPLOYEE_ID,
            cutover_date: `${CURRENT_YEAR}-07-01`,
            ytd_gross: 215000,
          },
        ],
      },
      'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const [item] = stagedItems(supabaseMock)
    expect(item.ytd_gross).toBe(215000)
    expect(item.ytd_tax).toBe(48000)
    expect(item.ytd_net).toBe(162000)
    expect(item.vacation_paid_days_remaining).toBe(12.5)
    expect(item.vacation_saved_days_by_year).toEqual({ [`${CURRENT_YEAR - 1}`]: 5 })
    expect(item.opening_semester_liability).toBe(42000)
    expect(item.opening_semester_liability_avgifter).toBe(13196.4)
    expect(item.karens_periods_adjustment).toBe(1)

    expect(result.preview.updated_rows).toBe(1)
    expect(result.preview.new_rows).toBe(0)
    expect(result.preview.fields_provided).toEqual(['ytd_gross'])
  })

  it('clears a field only when it is sent explicitly', async () => {
    const supabaseMock = mockWithStoredRow(STORED_ROW)

    await setOpeningBalances.execute(
      {
        items: [
          {
            employee_id: EMPLOYEE_ID,
            cutover_date: `${CURRENT_YEAR}-07-01`,
            karens_periods_adjustment: 0,
            vacation_saved_days_by_year: {},
          },
        ],
      },
      'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
    )

    const [item] = stagedItems(supabaseMock)
    expect(item.karens_periods_adjustment).toBe(0)
    expect(item.vacation_saved_days_by_year).toEqual({})
    // Untouched neighbours survive the clear.
    expect(item.opening_semester_liability).toBe(42000)
    expect(item.ytd_gross).toBe(210000)
  })

  it('first-time cutover still lands on the schema defaults', async () => {
    const supabaseMock = mockWithStoredRow(null)

    const result = (await setOpeningBalances.execute(
      {
        items: [
          {
            employee_id: EMPLOYEE_ID,
            cutover_date: `${CURRENT_YEAR}-07-01`,
            ytd_gross: 210000,
            ytd_tax: 48000,
          },
        ],
      },
      'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const [item] = stagedItems(supabaseMock)
    expect(item.ytd_gross).toBe(210000)
    expect(item.ytd_tax).toBe(48000)
    expect(item.ytd_net).toBe(0)
    expect(item.vacation_paid_days_remaining).toBe(0)
    expect(item.vacation_saved_days_by_year).toEqual({})
    expect(item.opening_semester_liability).toBe(0)
    expect(item.karens_periods_adjustment).toBe(0)
    expect(result.preview.new_rows).toBe(1)
    expect(result.preview.updated_rows).toBe(0)
  })

  it('validates the MERGED state, not the sparse patch', async () => {
    // Stored ytd_gross is 210000; lowering it below the stored ytd_tax must
    // fail rather than quietly persisting tax > gross.
    const supabaseMock = mockWithStoredRow(STORED_ROW)

    await expect(
      setOpeningBalances.execute(
        {
          items: [
            {
              employee_id: EMPLOYEE_ID,
              cutover_date: `${CURRENT_YEAR}-07-01`,
              ytd_gross: 1000,
            },
          ],
        },
        'company-1', 'user-1', supabaseMock as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/ytd_tax/)
  })
})

describe('gnubok_close_vacation_year', () => {
  const SAMPLE_REPORT = {
    vacation_year_start: '2025-01-01',
    vacation_year_end: '2025-12-31',
    next_year_start: '2026-01-01',
    basis: 'calendar',
    rows: [
      {
        employee_id: 'emp-1',
        employee_name: 'Anna Andersson',
        saveable_days: 5,
        expiring_days: 2,
      },
    ],
    sek: {
      computed_liability: 18690.84,
      computed_avgifter: 5872.66,
      booked_2920: 10000,
      booked_2940: 3142,
      drift_2920: 8690.84,
      drift_2940: 2730.66,
      adjustment_needed: true,
    },
    adjustment_date: '2025-12-31',
  }

  it('stages HIGH risk with the review report in the preview', async () => {
    mockPreviewClose.mockResolvedValue({ ok: true, data: SAMPLE_REPORT })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { salary_vacation_year_basis: 'calendar' } }) // basis lookup (year default)
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-6' }, error: null }) // pending_operations insert

    const result = (await closeVacationYear.execute(
      {}, 'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(result.preview.employee_count).toBe(1)
    expect(result.preview.drift_2920).toBe(8690.84)
    expect(result.preview.adjustment_needed).toBe(true)
  })

  it('fails staging when the preview refuses (already closed)', async () => {
    mockPreviewClose.mockResolvedValue({ ok: false, code: 'VACATION_YEAR_ALREADY_CLOSED' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { salary_vacation_year_basis: 'calendar' } })

    await expect(
      closeVacationYear.execute(
        { vacation_year_start: '2025-01-01' },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/VACATION_YEAR_ALREADY_CLOSED/)
  })
})
