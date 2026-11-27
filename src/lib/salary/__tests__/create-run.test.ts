import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createSalaryRunWithEmployees,
  resolveSalaryRunSeries,
  SalaryExtraRunError,
  SalaryRunExistsError,
} from '../create-run'

/** The rollout as the environment had it, restored after each test that sets it. */
const rolloutBefore = process.env.SALARY_EXTRA_RUNS_COMPANY_IDS

const mockEmit = vi.hoisted(() => vi.fn())
vi.mock('@/lib/events', () => ({ eventBus: { emit: (...a: unknown[]) => mockEmit(...a) } }))

/** The company_settings column default since the standard series set: lön in K. */
const STANDARD_SETTINGS = {
  default_voucher_series_per_source_type: { salary_payment: 'K', invoice_created: 'B' },
}

/** Thenable builder chain: every filter returns the chain, awaiting it (or
 * .single()/.maybeSingle()) yields the configured result. */
function chain(result: { data?: unknown; error?: unknown }) {
  const promise = Promise.resolve({ data: null, error: null, ...result })
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'limit', 'in', 'or']) {
    c[m] = () => c
  }
  c.single = () => promise
  c.maybeSingle = () => promise
  c.then = promise.then.bind(promise)
  return c
}

/**
 * Purpose-built mock: records inserts per table and answers the reads
 * create-run makes (employees roster, company_settings for the
 * avvikelseperiod, salary_runs for the overlap guard).
 */
function mockDb(opts: {
  employees?: Array<Record<string, unknown>>
  failLineItems?: boolean
  /** company_settings row; undefined = no row (fresh company). */
  settings?: Record<string, unknown> | null
  /** Live runs the overlap guard sees. */
  existingRuns?: Array<Record<string, unknown>>
  /** Roster rows of the other runs (several runs in one month). */
  siblingRoster?: Array<Record<string, unknown>>
}) {
  const inserts: Record<string, Array<Record<string, unknown>>> = {}
  const deletes: string[] = []

  const readResult = (table: string): { data: unknown } => {
    if (table === 'employees') return { data: opts.employees ?? [] }
    if (table === 'company_settings') return { data: opts.settings ?? null }
    if (table === 'salary_runs') return { data: opts.existingRuns ?? [] }
    if (table === 'salary_run_employees') return { data: opts.siblingRoster ?? [] }
    return { data: null }
  }

  const client = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserts[table] = inserts[table] || []
        inserts[table].push(row)
        if (table === 'salary_line_items') {
          const result = opts.failLineItems
            ? { error: { message: 'line item boom' } }
            : { error: null }
          return Promise.resolve(result)
        }
        return chain({ data: { id: `${table}-${inserts[table].length}`, ...row } })
      },
      select: () => chain(readResult(table)),
      delete: () => {
        deletes.push(table)
        return chain({ data: null })
      },
    }),
  }

  return { client: client as unknown as SupabaseClient, inserts, deletes }
}

const monthlyEmployee = {
  id: 'emp-1',
  salary_type: 'monthly',
  monthly_salary: 35000,
  employment_degree: 100,
  employment_type: 'employee',
  employment_start: '2025-01-01',
  employment_end: null,
  tax_table_number: 33,
  tax_column: 1,
}

describe('createSalaryRunWithEmployees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEmit.mockResolvedValue(undefined)
  })

  it('passes voucher_series and notes through to the run insert', async () => {
    const { client, inserts } = mockDb({ employees: [monthlyEmployee] })

    await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
      voucherSeries: 'L',
      notes: 'Juni',
    })

    expect(inserts.salary_runs[0]).toMatchObject({
      voucher_series: 'L',
      notes: 'Juni',
      period_year: 2026,
      period_month: 6,
    })
  })

  it("books an omitted series into the company's salary series, not the DB default 'A'", async () => {
    const { client, inserts } = mockDb({ employees: [monthlyEmployee], settings: STANDARD_SETTINGS })

    await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    })

    expect(inserts.salary_runs[0]).toMatchObject({ voucher_series: 'K' })
    expect(inserts.salary_runs[0]).not.toHaveProperty('notes')
  })

  it("falls back to 'A' for a company without a series map, and an explicit series wins", async () => {
    const bare = mockDb({ employees: [monthlyEmployee] })
    await createSalaryRunWithEmployees(bare.client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    })
    expect(bare.inserts.salary_runs[0]).toMatchObject({ voucher_series: 'A' })

    const explicit = mockDb({ employees: [monthlyEmployee], settings: STANDARD_SETTINGS })
    await createSalaryRunWithEmployees(explicit.client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
      voucherSeries: 'L',
    })
    expect(explicit.inserts.salary_runs[0]).toMatchObject({ voucher_series: 'L' })
  })

  it('seeds an hourly employee without a monthly salary, even with one left on the employee (crm#1337)', async () => {
    const hourlyEmployee = { ...monthlyEmployee, id: 'emp-2', salary_type: 'hourly', monthly_salary: 28000, hourly_rate: 185 }
    const { client, inserts } = mockDb({ employees: [monthlyEmployee, hourlyEmployee] })

    await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    })

    expect(inserts.salary_run_employees).toEqual([
      expect.objectContaining({ employee_id: 'emp-1', salary_type: 'monthly', monthly_salary: 35000 }),
      expect.objectContaining({ employee_id: 'emp-2', salary_type: 'hourly', monthly_salary: 0 }),
    ])
  })

  it('leaves the run empty when seedEmployees is false (the v1 contract)', async () => {
    const { client, inserts } = mockDb({ employees: [monthlyEmployee], settings: STANDARD_SETTINGS })

    const result = await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
      seedEmployees: false,
    })

    expect(result.employeeCount).toBe(0)
    expect(inserts.salary_runs).toHaveLength(1)
    expect(inserts.salary_run_employees).toBeUndefined()
    expect(inserts.salary_line_items).toBeUndefined()
  })

  it('emits salary_run.created once, whatever door created the run', async () => {
    const { client } = mockDb({ employees: [monthlyEmployee] })

    const result = await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    })

    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'salary_run.created',
      payload: {
        salaryRunId: result.run.id,
        periodYear: 2026,
        periodMonth: 6,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('keeps the created run when the event emit fails', async () => {
    mockEmit.mockRejectedValueOnce(new Error('bus down'))
    const { client, deletes } = mockDb({ employees: [monthlyEmployee] })

    const result = await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    })

    expect(result.employeeCount).toBe(1)
    expect(deletes).toEqual([])
  })

  it('snapshots the pay month as the avvikelseperiod when the company has no setting', async () => {
    const { client, inserts } = mockDb({ employees: [monthlyEmployee] })

    const result = await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 9,
      paymentDate: '2026-09-25',
    })

    expect(inserts.salary_runs[0]).toMatchObject({
      deviation_period_start: '2026-09-01',
      deviation_period_end: '2026-09-30',
    })
    expect(result.deviationWindow).toEqual({ start: '2026-09-01', end: '2026-09-30' })
  })

  it('reads the previous month when the company setting says so', async () => {
    const { client, inserts } = mockDb({
      employees: [monthlyEmployee],
      settings: { salary_deviation_period: 'previous_month' },
    })

    await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 9,
      paymentDate: '2026-09-25',
    })

    expect(inserts.salary_runs[0]).toMatchObject({
      deviation_period_start: '2026-08-01',
      deviation_period_end: '2026-08-31',
    })
  })

  it('explicit dates win over the setting', async () => {
    const { client, inserts } = mockDb({
      employees: [monthlyEmployee],
      settings: { salary_deviation_period: 'previous_month' },
    })

    await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 9,
      paymentDate: '2026-09-25',
      deviationPeriodStart: '2026-08-16',
      deviationPeriodEnd: '2026-09-15',
    })

    expect(inserts.salary_runs[0]).toMatchObject({
      deviation_period_start: '2026-08-16',
      deviation_period_end: '2026-09-15',
    })
  })

  it('refuses a window another live run already reads, before inserting anything', async () => {
    const { client, inserts } = mockDb({
      employees: [monthlyEmployee],
      settings: { salary_deviation_period: 'previous_month' },
      existingRuns: [
        { id: 'run-aug', period_year: 2026, period_month: 8, deviation_period_start: null, deviation_period_end: null },
      ],
    })

    await expect(
      createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
        periodYear: 2026,
        periodMonth: 9,
        paymentDate: '2026-09-25',
      }),
    ).rejects.toMatchObject({
      code: 'SALARY_RUN_DEVIATION_PERIOD_OVERLAP',
      details: { conflicting_run_id: 'run-aug' },
    })
    expect(inserts.salary_runs).toBeUndefined()
  })

  it('filters employees whose employment does not overlap the period', async () => {
    const { client, inserts } = mockDb({
      employees: [
        monthlyEmployee,
        { ...monthlyEmployee, id: 'emp-future', employment_start: '2026-08-01' },
        { ...monthlyEmployee, id: 'emp-ended', employment_end: '2026-05-31' },
      ],
    })

    const result = await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    })

    expect(result.employeeCount).toBe(1)
    expect(inserts.salary_run_employees).toHaveLength(1)
    expect(inserts.salary_run_employees[0].employee_id).toBe('emp-1')
  })

  it('compensating-deletes the run when a child insert fails', async () => {
    const { client, deletes } = mockDb({
      employees: [monthlyEmployee],
      failLineItems: true,
    })

    await expect(
      createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
        periodYear: 2026,
        periodMonth: 6,
        paymentDate: '2026-06-25',
      }),
    ).rejects.toThrow('line item boom')

    expect(deletes).toContain('salary_runs')
    expect(mockEmit).not.toHaveBeenCalled()
  })
})

describe('resolveSalaryRunSeries', () => {
  it("answers the company's salary series, an explicit letter, or 'A' without settings", async () => {
    expect(await resolveSalaryRunSeries(mockDb({ settings: STANDARD_SETTINGS }).client, 'company-1')).toBe('K')
    expect(await resolveSalaryRunSeries(mockDb({ settings: STANDARD_SETTINGS }).client, 'company-1', 'L')).toBe('L')
    expect(await resolveSalaryRunSeries(mockDb({}).client, 'company-1')).toBe('A')
  })

  it('fails closed when the settings read errors instead of guessing a series', async () => {
    const client = {
      from: () => ({ select: () => chain({ data: null, error: { message: 'timeout' } }) }),
    } as unknown as SupabaseClient
    await expect(resolveSalaryRunSeries(client, 'company-1')).rejects.toThrow(/timeout/)
  })
})

describe('duplicate period (23505)', () => {
  /** Insert trips the partial unique index; the re-select finds the winner. */
  function duplicateDb(existing: { id: string; status: string } | null) {
    const filters: unknown[][] = []
    const chain: Record<string, unknown> = {}
    for (const m of ['eq', 'neq', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        filters.push([m, ...args])
        return chain
      }
    }
    chain.maybeSingle = async () => ({ data: existing, error: null })
    const client = {
      from: (table: string) => ({
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` },
            }),
          }),
        }),
        select: () => chain,
        delete: () => ({ eq: () => ({ eq: async () => ({ data: null, error: null }) }) }),
      }),
    }
    return { client: client as unknown as SupabaseClient, filters }
  }

  it('throws SalaryRunExistsError naming the existing run and its status', async () => {
    const { client, filters } = duplicateDb({ id: 'run-existing', status: 'review' })
    const err = await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SalaryRunExistsError)
    const typed = err as SalaryRunExistsError
    expect(typed.existingId).toBe('run-existing')
    expect(typed.existingStatus).toBe('review')
    expect(typed.message).toBe('Salary run already exists for this period (id run-existing, status review)')
    // Corrected originals coexist with their correction: the lookup skips them.
    // Only the tail is the re-select; earlier filters belong to the
    // avvikelseperiod overlap check that runs before the insert.
    expect(filters.slice(-5)).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['eq', 'period_year', 2026],
      ['eq', 'period_month', 6],
      ['neq', 'status', 'corrected'],
      ['limit', 1],
    ])
  })

  it('keeps the bare message when the winner cannot be read back', async () => {
    const { client } = duplicateDb(null)
    await expect(
      createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
        periodYear: 2026,
        periodMonth: 6,
        paymentDate: '2026-06-25',
      }),
    ).rejects.toThrow('Salary run already exists for this period')
  })
})

describe('an extra run (several runs in one month)', () => {
  const hourlyEmployee = { ...monthlyEmployee, id: 'emp-hourly', salary_type: 'hourly', monthly_salary: null }
  // The period's run, paying the hourly staff on the 5th.
  const periodRun = {
    id: 'run-1',
    status: 'booked',
    period_year: 2026,
    period_month: 11,
    run_number: 1,
    payment_date: '2026-11-05',
    deviation_period_start: '2026-11-01',
    deviation_period_end: '2026-11-30',
    corrects_run_id: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockEmit.mockResolvedValue(undefined)
    process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = 'company-1'
  })

  afterEach(() => {
    if (rolloutBefore === undefined) delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    else process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = rolloutBefore
  })

  it("takes the period's next number, shares its window, and seeds only the employees no other run pays", async () => {
    const { client, inserts } = mockDb({
      employees: [hourlyEmployee, monthlyEmployee],
      existingRuns: [periodRun],
      siblingRoster: [{ employee_id: 'emp-hourly', salary_run_id: 'run-1' }],
    })

    const created = await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 11,
      paymentDate: '2026-11-26',
      extraRun: true,
    })

    expect(inserts.salary_runs[0]).toMatchObject({ run_number: 2, payment_date: '2026-11-26' })
    expect(inserts.salary_run_employees.map((row) => row.employee_id)).toEqual(['emp-1'])
    expect(created.employeeCount).toBe(1)
  })

  it('refuses an extra run for a company outside the list, before writing anything', async () => {
    delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    const { client, inserts } = mockDb({ employees: [monthlyEmployee], existingRuns: [periodRun] })

    await expect(
      createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
        periodYear: 2026,
        periodMonth: 11,
        paymentDate: '2026-11-26',
        extraRun: true,
      }),
    ).rejects.toMatchObject({ name: 'SalaryExtraRunError', reason: 'not_enabled', code: 'SALARY_EXTRA_RUN_UNAVAILABLE' })
    expect(inserts.salary_runs).toBeUndefined()
  })

  it('refuses an extra run for a company that calculates regionalt stöd', async () => {
    const { client, inserts } = mockDb({
      employees: [monthlyEmployee],
      existingRuns: [periodRun],
      settings: { salary_regional_support: true },
    })

    const attempt = createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 11,
      paymentDate: '2026-11-26',
      extraRun: true,
    })
    await expect(attempt).rejects.toBeInstanceOf(SalaryExtraRunError)
    await expect(attempt).rejects.toMatchObject({ reason: 'regional_support' })
    expect(inserts.salary_runs).toBeUndefined()
  })

  it("seeds an ordinary run without the employees another run of its payout month pays", async () => {
    // The October run paid on 5 November has the hourly staff: November's
    // ordinary run, paid on the 26th, seeds the monthly staff only.
    const octoberRun = { ...periodRun, id: 'run-oct', period_month: 10, run_number: 2, deviation_period_start: '2026-10-01', deviation_period_end: '2026-10-31' }
    const { client, inserts } = mockDb({
      employees: [hourlyEmployee, monthlyEmployee],
      existingRuns: [octoberRun],
      siblingRoster: [{ employee_id: 'emp-hourly', salary_run_id: 'run-oct' }],
    })

    await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 11,
      paymentDate: '2026-11-26',
    })

    expect(inserts.salary_runs[0]).not.toHaveProperty('run_number')
    expect(inserts.salary_run_employees.map((row) => row.employee_id)).toEqual(['emp-1'])
  })
})
