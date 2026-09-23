import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSalaryRunWithEmployees, SalaryRunExistsError } from '../create-run'

vi.mock('../account-mapping', () => ({
  getLineItemAccount: vi.fn(() => '7210'),
}))

/** Thenable builder chain: every filter returns the chain, awaiting it (or
 * .single()/.maybeSingle()) yields the configured result. */
function chain(result: { data?: unknown; error?: unknown }) {
  const promise = Promise.resolve({ data: null, error: null, ...result })
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'limit', 'in']) {
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
}) {
  const inserts: Record<string, Array<Record<string, unknown>>> = {}
  const deletes: string[] = []

  const readResult = (table: string): { data: unknown } => {
    if (table === 'employees') return { data: opts.employees ?? [] }
    if (table === 'company_settings') return { data: opts.settings ?? null }
    if (table === 'salary_runs') return { data: opts.existingRuns ?? [] }
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
  beforeEach(() => vi.clearAllMocks())

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

  it('omits voucher_series/notes when not provided (DB defaults apply — MCP path unchanged)', async () => {
    const { client, inserts } = mockDb({ employees: [monthlyEmployee] })

    await createSalaryRunWithEmployees(client, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 6,
      paymentDate: '2026-06-25',
    })

    expect(inserts.salary_runs[0]).not.toHaveProperty('voucher_series')
    expect(inserts.salary_runs[0]).not.toHaveProperty('notes')
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
