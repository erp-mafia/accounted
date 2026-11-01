import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { LEDGER_BALANCE_STATUSES, findOpeningBalanceFloor, sumAccountBalance } from '../gl-balance'

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

describe('sumAccountBalance', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sums debit - credit over posted AND reversed entries (the trial-balance predicate)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueGl(enqueue, [
      { debit_amount: 1000, credit_amount: 0 },
      { debit_amount: 0, credit_amount: 250.5 },
    ])

    const sum = await sumAccountBalance(supabase as never, 'company-1', '1630', {
      cutoffDate: '2026-08-20',
    })

    expect(sum).toBe(749.5)
    const inCalls = findCalls('journal_entries', 'in')
    expect(inCalls).toContainEqual(['status', [...LEDGER_BALANCE_STATUSES]])
    expect(LEDGER_BALANCE_STATUSES).toEqual(['posted', 'reversed'])
    // The old drift predicate was .eq('status', 'posted'): it must be gone.
    expect(findCalls('journal_entries', 'eq')).not.toContainEqual(['status', 'posted'])
    expect(findCalls('journal_entries', 'lte')).toContainEqual(['entry_date', '2026-08-20'])
    expect(findCalls('journal_entry_lines', 'eq')).toContainEqual(['account_number', '1630'])
  })

  it('applies beforeDate as an exclusive upper bound', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueGl(enqueue, [{ debit_amount: 10, credit_amount: 0 }])

    await sumAccountBalance(supabase as never, 'company-1', '1630', { beforeDate: '2025-01-17' })

    expect(findCalls('journal_entries', 'lt')).toContainEqual(['entry_date', '2025-01-17'])
  })

  it('returns 0 when nothing is booked on the account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueGl(enqueue, [])
    expect(await sumAccountBalance(supabase as never, 'company-1', '1630')).toBe(0)
  })

  it('returns null, never 0, when the read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'statement timeout' } })
    expect(await sumAccountBalance(supabase as never, 'company-1', '1630')).toBeNull()
  })
})

// The rule itself (a posted IB on a fiscal year's first day, a date whose IB
// entries cancel is none) is public.account_ib_floor, proved in
// tests/pg/bank-reconciliation-floor-and-window.pg.test.ts.
describe('findOpeningBalanceFloor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps the row the database answers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { floor_date: '2026-01-01', amount: '-2768.00', entry_ids: ['ib-2026'] } })

    const floor = await findOpeningBalanceFloor(supabase as never, 'company-1', '1630', '2026-09-27')

    expect(floor).toEqual({ date: '2026-01-01', amount: -2768, entryIds: ['ib-2026'] })
    expect(supabase.rpc).toHaveBeenCalledWith('account_ib_floor', {
      p_company_id: 'company-1',
      p_account_number: '1630',
      p_through: '2026-09-27',
    })
  })

  it('returns null when the database answers no floor', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await findOpeningBalanceFloor(supabase as never, 'company-1', '1630', '2026-09-27')).toBeNull()
  })

  it('throws on a read failure instead of guessing the floor', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'statement timeout' } })
    await expect(findOpeningBalanceFloor(supabase as never, 'company-1', '1630', '2026-09-27')).rejects.toThrow(
      /statement timeout/,
    )
  })
})
