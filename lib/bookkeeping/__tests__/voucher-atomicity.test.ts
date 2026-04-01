import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JournalEntryStatus } from '@/types'

// Mock event bus
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

import { commitEntry, getNextVoucherNumber } from '../engine'

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
    ).rejects.toThrow('Failed to get next voucher number: connection lost')
  })

  /**
   * commitEntry uses the atomic commit_journal_entry RPC which increments the
   * voucher sequence and updates the entry status in one transaction.
   * If the RPC fails (e.g., balance trigger rejection), the sequence increment
   * rolls back — no burned number, no gap.
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
    ).rejects.toThrow('Failed to commit journal entry: Journal entry is not balanced')

    // The atomic RPC was called — it failed, rolling back both the
    // sequence increment and the status update. No burned number.
    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'co-1',
      p_entry_id: 'entry-1',
    })

    // from() was never called — the RPC handles everything atomically
    expect(supabase.from).not.toHaveBeenCalled()
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
    })
    // from() called once to fetch the complete entry with lines
    expect(supabase.from).toHaveBeenCalledWith('journal_entries')
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
