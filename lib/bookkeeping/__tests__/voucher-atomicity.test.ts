import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JournalEntryStatus } from '@/types'

// Mock event bus
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}))

import { commitEntry, getNextVoucherNumber, createJournalEntry } from '../engine'
import { runWithActor } from '../actor-context-node'
import { BookkeepingDatabaseError } from '../errors'

describe('voucher number atomicity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getNextVoucherNumber returns incrementing numbers from RPC', async () => {
    let callCount = 0
    const supabase = {
      rpc: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({ data: callCount, error: null })
      }),
    }

    const n1 = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')
    const n2 = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')
    const n3 = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')

    expect(n1).toBe(1)
    expect(n2).toBe(2)
    expect(n3).toBe(3)
    expect(supabase.rpc).toHaveBeenCalledTimes(3)
  })

  it('getNextVoucherNumber throws on RPC error', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection lost' } }),
    }

    await expect(
      getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  /**
   * commitEntry uses the atomic commit_journal_entry RPC which increments the
   * voucher sequence and updates the entry status in one transaction.
   * If the RPC fails (e.g., balance trigger rejection), the sequence increment
   * rolls back: no burned number, no gap.
   */
  it('commitEntry RPC failure does not burn a sequence number', async () => {
    const supabase = {
      from: vi.fn(),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Journal entry is not balanced: debit=1000 credit=500' },
      }),
    }

    await expect(
      commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1')
    ).rejects.toThrow(BookkeepingDatabaseError)

    // The atomic RPC was called: it failed, rolling back both the
    // sequence increment and the status update. No burned number.
    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'co-1',
      p_entry_id: 'entry-1',
      p_commit_method: null,
      p_rubric_version: null,
      p_actor_type: null,
      p_actor_label: null,
    })

    // No line/entry fetch happened: the RPC handles everything atomically.
    // (PR10: commitEntry now also probes account_dimension_rules first; the
    // bare mock makes that probe fail open, which is exactly the posture.)
    expect(supabase.from).not.toHaveBeenCalledWith('journal_entries')
    expect(supabase.from).not.toHaveBeenCalledWith('journal_entry_lines')
  })

  it('commitEntry succeeds via atomic RPC and returns posted entry', async () => {
    const postedEntry = {
      id: 'entry-1',
      company_id: 'co-1',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      voucher_number: 3,
      status: 'posted' as JournalEntryStatus,
      lines: [],
    }

    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: postedEntry, error: null }),
          }),
        }),
      })),
      // Atomic RPC returns the assigned voucher number
      rpc: vi.fn().mockResolvedValue({ data: [{ voucher_number: 3 }], error: null }),
    }

    const result = await commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1')

    expect(result.voucher_number).toBe(3)
    expect(result.status).toBe('posted')
    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'co-1',
      p_entry_id: 'entry-1',
      p_commit_method: null,
      p_rubric_version: null,
      p_actor_type: null,
      p_actor_label: null,
    })
    // from() called once to fetch the complete entry with lines
    expect(supabase.from).toHaveBeenCalledWith('journal_entries')
  })

  /**
   * Actor attribution (migration 20260619120000): commitEntry forwards the
   * surrounding runWithActor() scope to the RPC so the immutable layer can
   * record WHO relayed the commit. Outside a scope the params stay null
   * (asserted by the two tests above).
   */
  it('commitEntry forwards the runWithActor scope to the RPC', async () => {
    const postedEntry = {
      id: 'entry-1',
      company_id: 'co-1',
      voucher_number: 1,
      status: 'posted' as JournalEntryStatus,
      lines: [],
    }
    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: postedEntry, error: null }),
          }),
        }),
      })),
      rpc: vi.fn().mockResolvedValue({ data: [{ voucher_number: 1 }], error: null }),
    }

    await runWithActor({ type: 'api_key', label: 'Claude Desktop' }, () =>
      commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1', 'api_key')
    )

    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'co-1',
      p_entry_id: 'entry-1',
      p_commit_method: 'api_key',
      p_rubric_version: null,
      p_actor_type: 'api_key',
      p_actor_label: 'Claude Desktop',
    })
  })

  /**
   * getNextVoucherNumber is still used by reverseEntry and storno-service.
   * Those flows INSERT a new entry (not UPDATE a draft), so the atomic
   * commit_journal_entry RPC doesn't apply. Burned numbers can still occur
   * in reversal/correction flows if the INSERT fails after the counter
   * increments. This is documented and expected.
   */
  it('getNextVoucherNumber remains available for reversal/storno flows', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 7, error: null }),
    }

    const num = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'B')

    expect(num).toBe(7)
    expect(supabase.rpc).toHaveBeenCalledWith('next_voucher_number', {
      p_company_id: 'co-1',
      p_fiscal_period_id: 'fp-1',
      p_series: 'B',
    })
  })
})

describe('createJournalEntry orphan draft cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * Regression test for #292: when commit_journal_entry RPC fails (e.g. overload
   * ambiguity, balance trigger, period lock), the draft created by createDraftEntry
   * must be cancelled so it doesn't linger as an undeletable stuck draft.
   */
  it('cancels the draft when commit RPC fails', async () => {
    const draftId = 'entry-1'
    const cancelUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    })

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { account_number: '1930', id: 'acc-1930' },
                      { account_number: '1510', id: 'acc-1510' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft' as JournalEntryStatus },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft', lines: [] },
                  error: null,
                }),
              }),
            }),
            update: cancelUpdate,
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        return {}
      }),
      // commit_journal_entry RPC fails: simulates overload ambiguity or balance error
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Could not choose the best candidate function' },
      }),
    }

    await expect(
      createJournalEntry(supabase as never, 'co-1', 'user-1', {
        fiscal_period_id: 'fp-1',
        entry_date: '2025-06-15',
        description: 'Payment',
        source_type: 'invoice_paid',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
      })
    ).rejects.toThrow(BookkeepingDatabaseError)

    // The orphan draft must have been cancelled with CAS guard (status='draft')
    expect(cancelUpdate).toHaveBeenCalledWith({ status: 'cancelled' })
    const firstEq = cancelUpdate.mock.results[0].value.eq
    expect(firstEq).toHaveBeenCalledWith('id', draftId)
    const secondEq = firstEq.mock.results[0].value.eq
    expect(secondEq).toHaveBeenCalledWith('status', 'draft')
  })

  it('surfaces original commit error even if cleanup update fails', async () => {
    const draftId = 'entry-1'

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { account_number: '1930', id: 'acc-1930' },
                      { account_number: '1510', id: 'acc-1510' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft' as JournalEntryStatus },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft', lines: [] },
                  error: null,
                }),
              }),
            }),
            // Cleanup throws: original error should still propagate
            update: vi.fn().mockImplementation(() => {
              throw new Error('Network error during rollback')
            }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        return {}
      }),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Period is locked' },
      }),
    }

    await expect(
      createJournalEntry(supabase as never, 'co-1', 'user-1', {
        fiscal_period_id: 'fp-1',
        entry_date: '2025-06-15',
        description: 'Payment',
        source_type: 'invoice_paid',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
      })
      // Original commit error surfaces, not the cleanup error
    ).rejects.toThrow('Period is locked')
  })
})
