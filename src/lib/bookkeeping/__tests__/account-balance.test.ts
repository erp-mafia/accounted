import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { accountBalanceThrough } from '../account-balance'

/**
 * The two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts) reads the
 * parent entries first, then the bare lines keyed by journal_entry_id.
 */
function enqueueGl(
  enqueue: (r: { data?: unknown; error?: unknown }) => void,
  rows: Array<{ debit_amount: number; credit_amount: number }>,
) {
  enqueue({ data: rows.length ? [{ id: 'entry-1' }] : [] })
  if (rows.length === 0) return
  enqueue({
    data: rows.map((r, i) => ({ id: `line-${i}`, journal_entry_id: 'entry-1', ...r })),
  })
}

describe('accountBalanceThrough', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts from the latest ingående balans on, so the years it restates count once', async () => {
    // 2893 after one year-end: the loan of 2025 (credit 50 000) and the IB of
    // 2026 that restates it. Every posting sums to -100 000; the balance is
    // -50 000, read from the IB date on.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { floor_date: '2026-01-01', amount: '-50000.00', entry_ids: ['ib-2026'] } })
    enqueueGl(enqueue, [{ debit_amount: 0, credit_amount: 50000 }])

    const balance = await accountBalanceThrough(supabase as never, 'company-1', '2893', '2026-11-12')

    expect(balance).toBe(-50000)
    expect(supabase.rpc).toHaveBeenCalledWith('account_ib_floor', {
      p_company_id: 'company-1',
      p_account_number: '2893',
      p_through: '2026-11-12',
    })
    expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-01-01'])
    expect(findCalls('journal_entries', 'lte')).toContainEqual(['entry_date', '2026-11-12'])
  })

  it('sums all history through the day for an account that never had an ingående balans', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueueGl(enqueue, [
      { debit_amount: 0, credit_amount: 50000 },
      { debit_amount: 12000, credit_amount: 0 },
    ])

    expect(await accountBalanceThrough(supabase as never, 'company-1', '2893', '2026-11-12')).toBe(-38000)
    expect(findCalls('journal_entries', 'gte')).toEqual([])
    expect(findCalls('journal_entries', 'lte')).toContainEqual(['entry_date', '2026-11-12'])
  })

  it('answers null, never 0, when the lines cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ error: { message: 'connection reset' } })
    expect(await accountBalanceThrough(supabase as never, 'company-1', '2893', '2026-11-12')).toBeNull()
  })

  it('throws when the ingående balans cannot be read: without the floor there is no balance to state', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'statement timeout' } })
    await expect(accountBalanceThrough(supabase as never, 'company-1', '2893', '2026-11-12')).rejects.toThrow(
      /statement timeout/,
    )
  })
})
