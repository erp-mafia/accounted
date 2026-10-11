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
})
