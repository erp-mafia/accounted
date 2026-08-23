import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_list_uncategorized_transactions')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_list_uncategorized_transactions', () => {
  it('is registered as a read-only paginated tool', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const schema = tool.outputSchema as Record<string, unknown>
    expect((schema.properties as Record<string, unknown>).transactions).toBeDefined()
    expect((schema.properties as Record<string, unknown>).total_count).toBeDefined()
  })

  it('returns rows when DB has null merchant_name, reference, is_business (MCP structured output)', async () => {
    const rows = [
      {
        id: 't-uncat-1',
        date: '2026-03-09',
        description: 'Transfer',
        amount: -6000,
        currency: 'SEK',
        merchant_name: null,
        reference: null,
        is_business: null,
        category: null,
      },
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null, count: 1 })
    enqueue({ data: rows, error: null })

    const result = (await tool.execute(
      { limit: 20 },
      'company-1',
      'user-1',
      supabase as never
    )) as {
      transactions: typeof rows
      count: number
      total_count: number
      has_more: boolean
    }

    expect(result.count).toBe(1)
    expect(result.transactions[0].merchant_name).toBeNull()
    expect(result.transactions[0].reference).toBeNull()
    expect(result.transactions[0].is_business).toBeNull()
  })

  it('exposes cash_account_id and resolves the bank account ledger per row', async () => {
    // Customer report (A4): nothing on the API said which bank account a
    // transaction belongs to, so per-account reconciliation was impossible.
    const rows = [
      { id: 't-1', date: '2026-03-09', description: 'A', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: 'ca-1930' },
      { id: 't-2', date: '2026-03-08', description: 'B', amount: -20, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null },
    ]
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null, error: null, count: 2 })
    enqueue({ data: rows, error: null })
    enqueue({ data: [{ id: 'ca-1930', ledger_account: '1930' }], error: null })

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<{ transaction_id: string; cash_account_id: string | null; cash_account_ledger: string | null }>
    }

    expect(result.transactions[0]).toMatchObject({ transaction_id: 't-1', cash_account_id: 'ca-1930', cash_account_ledger: '1930' })
    expect(result.transactions[1]).toMatchObject({ transaction_id: 't-2', cash_account_id: null, cash_account_ledger: null })
    // The ledger lookup is scoped to the company and the ids on this page.
    const inCalls = findCalls('cash_accounts', 'in')
    expect(inCalls).toEqual([['id', ['ca-1930']]])
  })

  it('narrows both the count and the page to one bank account when cash_account_id is given', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null, error: null, count: 0 })
    enqueue({ data: [], error: null })

    await tool.execute({ limit: 20, cash_account_id: 'ca-1940' }, 'company-1', 'user-1', supabase as never)

    const eqCalls = findCalls('transactions', 'eq').filter((args) => args[0] === 'cash_account_id')
    expect(eqCalls).toEqual([['cash_account_id', 'ca-1940'], ['cash_account_id', 'ca-1940']])
    // No ledger lookup when the page is empty.
    expect(findCalls('cash_accounts', 'in')).toHaveLength(0)
  })
})
