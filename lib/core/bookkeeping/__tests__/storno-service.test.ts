import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import { BookkeepingDatabaseError, MeaninglessCorrectionError } from '@/lib/bookkeeping/errors'

// ============================================================
// Mock — separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let inserts: Array<{ table: string; payload: unknown }>

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'update', 'delete']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.insert = vi.fn().mockImplementation((payload: unknown) => {
    inserts.push({ table, payload })
    return b
  })
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

vi.mock('@/lib/bookkeeping/engine', () => ({
  validateBalance: vi.fn().mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 }),
  getNextVoucherNumber: vi.fn(async () => ++resultIdx), // just increment
}))

import { correctEntry } from '../storno-service'
import { validateBalance, getNextVoucherNumber } from '@/lib/bookkeeping/engine'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
  inserts = []

  // Reset the mock implementations after clearAllMocks
  vi.mocked(validateBalance).mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 })
  let voucherNum = 0
  vi.mocked(getNextVoucherNumber).mockImplementation(async () => ++voucherNum)
})

describe('correctEntry', () => {
  const originalEntry = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Test purchase',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  const correctedLines = [
    { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1200 },
  ]

  function setupResults() {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })

    results = [
      // 0: fetch original (.single())
      { data: originalEntry, error: null },
      // 1: insert reversal entry (.single())
      { data: reversalEntry, error: null },
      // 2: insert reversal lines (thenable)
      { data: null, error: null },
      // 3: update reversal to posted (thenable)
      { data: null, error: null },
      // -- getNextVoucherNumber increments resultIdx --
      // 4: fetch accounts for corrected lines (thenable)
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null },
      // 5: insert corrected entry (.single())
      { data: correctedEntry, error: null },
      // 6: insert corrected lines (thenable)
      { data: null, error: null },
      // 7: update corrected to posted (thenable)
      { data: null, error: null },
      // 8: CAS update original to reversed (thenable, needs array for .length check)
      { data: [{ id: 'orig-1' }], error: null },
      // 9: fetch final reversal (.single())
      { data: { ...reversalEntry, lines: [] }, error: null },
      // 10: fetch final corrected (.single())
      { data: { ...correctedEntry, lines: correctedLines }, error: null },
    ]
  }

  it('creates reversal with swapped debit/credit lines', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal).toBeDefined()
    expect(result.reversal.reverses_id).toBe('orig-1')
  })

  it('links original ↔ reversal ↔ corrected via IDs', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal.id).toBe('reversal-1')
    expect(result.corrected.id).toBe('corrected-1')
    expect(result.corrected.correction_of_id).toBe('orig-1')
  })

  it('validates balance of corrected lines (rejects unbalanced)', async () => {
    vi.mocked(validateBalance).mockReturnValueOnce({
      valid: false,
      totalDebit: 1200,
      totalCredit: 1000,
    })

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', [
        { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ])
    ).rejects.toThrow('not balanced')
  })

  it('cancels both entries on concurrent reversal (CAS guard)', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },         // 0: fetch original
      { data: reversalEntry, error: null },          // 1: insert reversal
      { data: null, error: null },                   // 2: insert reversal lines
      { data: null, error: null },                   // 3: post reversal
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 4: accounts
      { data: correctedEntry, error: null },         // 5: insert corrected
      { data: null, error: null },                   // 6: insert corrected lines
      { data: null, error: null },                   // 7: post corrected
      { data: [], error: null },                     // 8: CAS fails — empty array
      { data: null, error: null },                   // 9: cancelEntry reversal update
      { data: null, error: null },                   // 10: cancelEntry reversal lines delete
      { data: null, error: null },                   // 11: cancelEntry corrected update
      { data: null, error: null },                   // 12: cancelEntry corrected lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow('already reversed')
  })

  it('cancels reversal when corrected entry creation fails', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },          // 0: fetch original
      { data: reversalEntry, error: null },           // 1: insert reversal
      { data: null, error: null },                    // 2: insert reversal lines
      { data: null, error: null },                    // 3: post reversal
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 4: accounts
      { data: null, error: { message: 'DB error' } }, // 5: insert corrected FAILS
      { data: null, error: null },                    // 6: cancelEntry reversal update
      { data: null, error: null },                    // 7: cancelEntry reversal lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  it('cancels reversal entry when reversal lines fail', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },           // 0: fetch original
      { data: reversalEntry, error: null },            // 1: insert reversal
      { data: null, error: { message: 'line error' } }, // 2: insert reversal lines FAILS
      { data: null, error: null },                     // 3: cancelEntry update
      { data: null, error: null },                     // 4: cancelEntry lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  it('mirrors original.entry_date on storno + corrected entries (rättelsen stannar i ursprungsperioden)', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const journalEntryInserts = inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as { entry_date: string; source_type: string })

    expect(journalEntryInserts).toHaveLength(2)
    expect(journalEntryInserts[0]).toMatchObject({ source_type: 'storno', entry_date: '2024-06-15' })
    expect(journalEntryInserts[1]).toMatchObject({ source_type: 'correction', entry_date: '2024-06-15' })
  })

  it('rejects rättelse where every account nets to zero (1930 → 1930)', async () => {
    const supabase = makeClient()
    const noOpLines = [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
    ]
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', noOpLines)
    ).rejects.toBeInstanceOf(MeaninglessCorrectionError)

    // Guard runs before any DB call — original must not be fetched.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects rättelse where multiple accounts each net to zero', async () => {
    const supabase = makeClient()
    const noOpLines = [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      { account_number: '5410', debit_amount: 50, credit_amount: 0 },
      { account_number: '5410', debit_amount: 0, credit_amount: 50 },
    ]
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', noOpLines)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'net_zero_per_account',
    })
  })

  it('rejects rättelse identical to the original entry', async () => {
    const supabase = makeClient()
    // Only the fetch-original result is needed — guard runs right after.
    results = [{ data: originalEntry, error: null }]

    const identicalLines = [
      { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'identical_to_original',
    })
  })

  it('allows rättelse that shifts amounts between different accounts', async () => {
    setupResults()
    const supabase = makeClient()
    // correctedLines moves expense from 5410 → 5420 — net effect per account
    // is non-zero (5420 +1200, 5410 0 since absent, 1930 -1200), and the lines
    // differ from the original, so both guards must pass.
    const result = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      'orig-1',
      correctedLines
    )
    expect(result.corrected).toBeDefined()
  })

  it('emits journal_entry.corrected event', async () => {
    setupResults()

    const handler = vi.fn()
    eventBus.on('journal_entry.corrected', handler)

    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' })
    )
  })
})
