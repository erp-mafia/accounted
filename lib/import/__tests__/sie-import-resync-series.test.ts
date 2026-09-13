/**
 * Feedback seq 345150: the IB resync after a prior-year import stornoed the
 * old opening-balance voucher in its own series (the RPC's COALESCE on the
 * old row) but booked the replacement in the engine's default series, so a
 * company whose IB lived in M got "Makulering" as M and the new IB as A15,
 * out of date order. The resync must read the old entry's series and pass
 * it to the replacement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ParsedSIEFile } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  replaceOpeningBalanceEntry: vi.fn(async () => ({
    newEntryId: 'ob-new',
    stornoEntryId: 'ob-storno',
    newVoucherNumber: 2,
    stornoVoucherNumber: 1,
  })),
}))

import { replaceOpeningBalanceEntry } from '@/lib/bookkeeping/engine'
import { resyncNextPeriodOpeningBalance } from '../sie-import'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const NEXT_PERIOD = {
  id: 'fp-2026',
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
  opening_balance_entry_id: 'ob-old',
  opening_balances_set: true,
}

const parsed = {
  closingBalances: [
    { yearIndex: 0, account: '1930', amount: 1000 },
    { yearIndex: 0, account: '2099', amount: -1000 },
  ],
} as unknown as ParsedSIEFile

function resync() {
  return resyncNextPeriodOpeningBalance(
    supabase as unknown as SupabaseClient,
    'co-1',
    'user-1',
    '2025-12-31',
    parsed,
    new Map(),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('resyncNextPeriodOpeningBalance: replacement series (feedback seq 345150)', () => {
  it("books the replacement in the replaced entry's series, not the engine default", async () => {
    enqueue({ data: NEXT_PERIOD }) // fiscal_periods
    enqueue({ data: { voucher_series: 'M' } }) // journal_entries: the old IB

    const result = await resync()

    expect(result).toMatchObject({ resynced: true, stornoEntryId: 'ob-storno', newOpeningBalanceEntryId: 'ob-new' })
    expect(replaceOpeningBalanceEntry).toHaveBeenCalledTimes(1)
    const [, companyId, , expectedOldId, input] = vi.mocked(replaceOpeningBalanceEntry).mock.calls[0]
    expect(companyId).toBe('co-1')
    expect(expectedOldId).toBe('ob-old')
    expect(input).toMatchObject({
      fiscal_period_id: 'fp-2026',
      entry_date: '2026-01-01',
      source_type: 'opening_balance',
      voucher_series: 'M',
    })
  })

  it("falls back to A for a legacy entry without a series, mirroring the RPC's storno fallback", async () => {
    enqueue({ data: NEXT_PERIOD }) // fiscal_periods
    enqueue({ data: { voucher_series: null } }) // journal_entries

    await resync()

    expect(vi.mocked(replaceOpeningBalanceEntry).mock.calls[0][4]).toMatchObject({ voucher_series: 'A' })
  })

  it('fails closed when the old entry cannot be read instead of guessing a series', async () => {
    enqueue({ data: NEXT_PERIOD }) // fiscal_periods
    enqueue({ data: null, error: { message: 'rls denied' } }) // journal_entries

    await expect(resync()).rejects.toThrow('Failed to read the opening balance entry to replace')
    expect(replaceOpeningBalanceEntry).not.toHaveBeenCalled()
  })
})
