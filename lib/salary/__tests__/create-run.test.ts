import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSalaryRunWithEmployees } from '../create-run'

vi.mock('../account-mapping', () => ({
  getLineItemAccount: vi.fn(() => '7210'),
}))

/**
 * Purpose-built mock: records inserts per table, supports the chains
 * create-run uses (insert().select().single(), select().eq().eq(),
 * delete().eq().eq()).
 */
function mockDb(opts: {
  employees?: Array<Record<string, unknown>>
  failLineItems?: boolean
}) {
  const inserts: Record<string, Array<Record<string, unknown>>> = {}
  const deletes: string[] = []

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
        return {
          select: () => ({
            single: async () => ({
              data: { id: `${table}-${inserts[table].length}`, ...row },
              error: null,
            }),
          }),
        }
      },
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: opts.employees ?? [], error: null }),
        }),
      }),
      delete: () => ({
        eq: () => ({
          eq: async () => {
            deletes.push(table)
            return { data: null, error: null }
          },
        }),
      }),
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
