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

// Synthetic fixture personnummer (year 1900, zero suffix).
const SAMPLE_PERSONNUMMER = '190001010000'

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

  it('rejects a payment_date outside the run period month (kontantprincipen)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW }) // draft gate passes; period is 2026-03

    await expect(
      updateSalaryRun.execute(
        { salary_run_id: 'run-1', payment_date: '2026-04-05' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/SALARY_RUN_PAYMENT_DATE_OUTSIDE_PERIOD/)
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

  it('rejects a malformed payment_date before touching the run', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateSalaryRun.execute(
        { salary_run_id: 'run-1', payment_date: '23/03/2026' },
        'company-1', 'user-1', supabase as never, { type: 'user' },
      ),
    ).rejects.toThrow(/VALIDATION_ERROR/)
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

  it('stages high-risk with a totals preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RUN_ROW }) // salary_runs lookup
    enqueue({ data: [{ id: 'sre-1', calculation_breakdown: { steps: [] } }] }) // roster preflight
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
    expect(result.preview.current_status).toBe('review')
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
})

describe('gnubok_delete_absence', () => {
  it('stages with a deleted-day-count preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'emp-1' } }) // service assertEmployee (dry-run preflight)
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
    expect(inserted.params.personnummer_last4).toBe('0000')
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

  it('rejects invalid input via CreateEmployeeSchema (missing salary)', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createEmployee.execute(
        { ...validArgs, monthly_salary: undefined },
        'company-1', 'user-1', supabase as never, { type: 'agent_chat' },
      ),
    ).rejects.toThrow(/Invalid employee/)
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
