import { describe, it, expect } from 'vitest'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { listExpenseClaims } from '../expense-claims-service'

describe('listExpenseClaims', () => {
  it('returns every claim past 1,000, paged on date, created_at and id', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      expense_claims: manyRows(1001, (i) => ({ id: `claim-${i}`, expense_date: '2026-10-01', created_at: '2026-10-01T00:00:00Z' })),
    })

    const claims = await listExpenseClaims(supabase as never, 'company-1')

    expect(claims).toHaveLength(1001)
    expect(findCalls('expense_claims', 'order').map((a) => a[0]).slice(0, 3)).toEqual(['expense_date', 'created_at', 'id'])
  })

  it('says for each claim whether it waits for a payout, and which salary run repays one on a payslip (crm#1942)', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      expense_claims: [
        { id: 'c-run', status: 'registered' },
        { id: 'c-open', status: 'registered' },
        { id: 'c-paid', status: 'paid' },
      ],
      salary_line_items: [
        {
          id: 'line-1',
          source_expense_claim_id: 'c-run',
          salary_run_employee: {
            salary_run: { id: 'run-1', status: 'draft', period_year: 2026, period_month: 10, payment_date: '2026-10-25' },
          },
        },
      ],
    })

    const claims = await listExpenseClaims(supabase as never, 'company-1')

    expect(claims.map((c) => [c.id, c.awaits_payout, c.salary_run?.salary_run_id ?? null])).toEqual([
      ['c-run', false, 'run-1'],
      ['c-open', true, null],
      ['c-paid', false, null],
    ])
    expect(claims[0].salary_run).toEqual({
      salary_run_id: 'run-1',
      status: 'draft',
      period_year: 2026,
      period_month: 10,
      payment_date: '2026-10-25',
    })
    // The payslip is looked up for registered claims only.
    expect(findCalls('salary_line_items', 'in')).toEqual([['source_expense_claim_id', ['c-run', 'c-open']]])
  })
})
