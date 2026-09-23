import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_list_uncategorized_transactions')!

// Query order per call: (1) ids of pointer-unbooked rows, (2) their
// transaction_voucher_links rows, (3) the page, (4) cash_accounts when a page
// row carries a cash_account_id. (2) and (3) are skipped on an empty result.
function enqueueIds(enqueue: (r: { data?: unknown; error?: unknown; count?: number | null }) => void, ids: string[]) {
  enqueue({ data: ids.map((id) => ({ id })), error: null })
}

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
    enqueueIds(enqueue, ['t-uncat-1'])
    enqueue({ data: [], error: null }) // transaction_voucher_links
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
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
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
    enqueueIds(enqueue, ['t-1', 't-2'])
    enqueue({ data: [], error: null }) // transaction_voucher_links
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

  it('narrows both the id read and the page to one bank account when cash_account_id is given', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueIds(enqueue, ['t-1'])
    enqueue({ data: [], error: null }) // transaction_voucher_links
    enqueue({ data: [{ id: 't-1', date: '2026-03-09', description: 'A', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null }], error: null })

    const CA = '550e8400-e29b-41d4-a716-446655441940'
    await tool.execute({ limit: 20, cash_account_id: CA }, 'company-1', 'user-1', supabase as never)

    const eqCalls = findCalls('transactions', 'eq').filter((args) => args[0] === 'cash_account_id')
    expect(eqCalls).toEqual([['cash_account_id', CA], ['cash_account_id', CA]])
    // No ledger lookup when no page row carries a cash_account_id.
    expect(findCalls('cash_accounts', 'in')).toHaveLength(0)
  })

  it('skips the junction and page reads when nothing is unbooked', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueIds(enqueue, [])

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: unknown[]
      total_count: number
      has_more: boolean
    }

    expect(result).toMatchObject({ transactions: [], total_count: 0, has_more: false })
    expect(findCalls('transaction_voucher_links', 'in')).toHaveLength(0)
    expect(findCalls('transactions', 'in')).toHaveLength(0)
  })

  it('rejects a ledger number passed as cash_account_id with a clear message', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute({ limit: 20, cash_account_id: '1930' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/cash_account_id must be a cash account UUID/)
  })

  it('excludes ignored transactions from both the id read and the page', async () => {
    // A transaction ignored via gnubok_ignore_transaction has journal_entry_id
    // NULL by CHECK constraint, so "no journal entry yet" alone kept listing
    // it as work to do (feedback seq 330091). Same predicate as the worklist:
    // journal_entry_id IS NULL AND is_ignored = false, on both queries.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueIds(enqueue, ['t-1'])
    enqueue({ data: [], error: null }) // transaction_voucher_links
    enqueue({ data: [{ id: 't-1', date: '2026-03-09', description: 'A', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null }], error: null })

    await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)

    expect(findCalls('transactions', 'is')).toEqual([
      ['journal_entry_id', null],
      ['journal_entry_id', null],
    ])
    expect(findCalls('transactions', 'eq').filter((args) => args[0] === 'is_ignored')).toEqual([
      ['is_ignored', false],
      ['is_ignored', false],
    ])
  })

  it('leaves out rows anchored only through transaction_voucher_links, from the page and the total (split row, crm#48)', async () => {
    // A bank row split over V200 + V201 (#1553) has journal_entry_id NULL and
    // two bank_line junction rows: it is booked, not work to do.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueIds(enqueue, ['t-split', 't-open', 't-open-2'])
    enqueue({ data: [{ transaction_id: 't-split' }, { transaction_id: 't-split' }], error: null })
    enqueue({
      data: [
        { id: 't-open', date: '2026-08-19', description: 'Open', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null },
      ],
      error: null,
    })

    const result = (await tool.execute({ limit: 1 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<{ transaction_id: string }>
      total_count: number
      has_more: boolean
      next_offset?: number
    }

    // The page asked the DB only for the ids that survived the subtraction.
    expect(findCalls('transactions', 'in')).toEqual([['id', ['t-open']]])
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t-open'])
    // Total and paging count the open rows, not the pointer-NULL ones.
    expect(result.total_count).toBe(2)
    expect(result.has_more).toBe(true)
    expect(result.next_offset).toBe(1)
  })
})
