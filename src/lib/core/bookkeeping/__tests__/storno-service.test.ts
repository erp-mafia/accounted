import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import type { CreateJournalEntryLineInput } from '@/types'
import {
  BookkeepingDatabaseError,
  CorrectionBankAccountChangedError,
  CorrectionChainTooDeepError,
  EntryAlreadyReversedError,
  ImportVatWithoutBaseError,
  MeaninglessCorrectionError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'

// ============================================================
// Mock: separate client (no .then) from query builder (thenable)
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
  // Posting a draft through commit_journal_entry (number, status and commit
  // stamp together). Consumes the queued result in the slot the client-side
  // "update to posted" used to take, so the queues below keep their order.
  commitStornoOrCorrectionDraft: vi.fn(),
  // The gated cleanup door (cancel_orphaned_entry RPC). Consumes no queued
  // result: rollbacks no longer issue client-side UPDATE/DELETE statements.
  cancelOrphanedEntry: vi.fn(async () => ({ error: null })),
  // The storno's bank release (has its own tests in engine.test.ts). Consumes
  // no queued result.
  releaseBankRowsOfReversedEntry: vi.fn(async () => undefined),
}))

// The storno target check has its own tests (storno-target.test.ts); here it
// passes, and the locked-year tests below make it refuse or move the storno.
// Neither it nor the standing-storno read consumes a queued result; the
// reference texts are the real ones.
const mockAssertStornoTarget = vi.fn(
  async (
    _supabase: unknown,
    _companyId: string,
    original: { entry_date: string; fiscal_period_id: string },
    date?: string,
    _options?: unknown,
  ): Promise<{ date: string; fiscal_period_id: string; moved: boolean }> => ({
    date: date ?? original.entry_date,
    fiscal_period_id: original.fiscal_period_id,
    moved: false,
  }),
)
const mockIsStandingStorno = vi.fn(async (..._args: unknown[]) => true)
vi.mock('@/lib/core/bookkeeping/storno-target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-target')>()),
  assertStornoTarget: (...args: Parameters<typeof mockAssertStornoTarget>) => mockAssertStornoTarget(...args),
  isStandingStorno: (...args: unknown[]) => mockIsStandingStorno(...args),
}))

// Where a dated rättelse lands (crm#1368): only called when a caller gives
// a new date without its period; every other test never reaches it.
const mockResolvePeriod = vi.fn()
vi.mock('@/lib/core/bookkeeping/period-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/period-service')>()),
  resolvePeriodStatusForDate: (...args: unknown[]) => mockResolvePeriod(...args),
}))

// The company's momsruta per account for the importmoms rule (#94): the BAS
// map only, no account of its own (import-vat-base.test.ts covers the rest).
const mockFetchDynamic = vi.fn()
vi.mock('@/lib/reports/vat-revenue-accounts', () => ({
  fetchDynamicVatAccounts: (...args: unknown[]) => mockFetchDynamic(...args),
}))

// On-demand BAS backfill, default: nothing seedable. Tests override.
const mockBackfill = vi.fn()
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => mockBackfill(...args),
}))

// A bank row's money stays on its own account (correction-bank-leg.test.ts
// covers the rule): passes here, one test below makes it refuse. Consumes no
// queued result.
const mockAssertBankAccount = vi.fn()
vi.mock('@/lib/core/bookkeeping/correction-bank-leg', () => ({
  assertCorrectionKeepsBankAccount: (...args: unknown[]) => mockAssertBankAccount(...args),
}))

// The invoice payment rows and the records the verifikat books (the invoice,
// the inbox item, the utlägg) follow the correction
// (correction-payment-relink.test.ts covers the queries). Neither consumes a
// queued result.
const mockRelinkPaymentRows = vi.fn(async (): Promise<string | undefined> => undefined)
const mockRelinkBookedRecords = vi.fn(async (): Promise<string | undefined> => undefined)
vi.mock('@/lib/core/bookkeeping/correction-payment-relink', () => ({
  relinkPaymentRowsToEntry: (...args: unknown[]) => mockRelinkPaymentRows(...(args as [])),
  relinkBookedRecordsToEntry: (...args: unknown[]) => mockRelinkBookedRecords(...(args as [])),
}))

import { correctEntry } from '../storno-service'
import { CORRECTION_COLUMN_POLICY } from '../correction-column-policy'
import {
  validateBalance,
  commitStornoOrCorrectionDraft,
  cancelOrphanedEntry,
  releaseBankRowsOfReversedEntry,
} from '@/lib/bookkeeping/engine'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
  inserts = []

  // Reset the mock implementations after clearAllMocks
  vi.mocked(validateBalance).mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 })
  vi.mocked(commitStornoOrCorrectionDraft).mockImplementation(async () => {
    const result = results[resultIdx++] ?? { data: null, error: null }
    return { error: (result.error as { message: string } | null | undefined) ?? null }
  })
  vi.mocked(cancelOrphanedEntry).mockResolvedValue({ error: null })
  mockBackfill.mockResolvedValue([])
  mockAssertBankAccount.mockResolvedValue(undefined)
  mockFetchDynamic.mockResolvedValue({ mappingByAccount: new Map(), explicitAccounts: new Set() })
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
      // 1: fetch accounts for corrected lines: Step 0 pre-validation (thenable)
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null },
      // 2: insert reversal entry (.single())
      { data: reversalEntry, error: null },
      // 3: insert reversal lines (thenable)
      { data: null, error: null },
      // 4: post reversal (commit_journal_entry)
      { data: null, error: null },
      // 5: insert corrected entry (.single())
      { data: correctedEntry, error: null },
      // 6: insert corrected lines (thenable)
      { data: null, error: null },
      // 7: post corrected (commit_journal_entry)
      { data: null, error: null },
      // 8: CAS update original to reversed (thenable, needs array for .length check)
      { data: [{ id: 'orig-1' }], error: null },
      // 9: relink transactions original → corrected (thenable)
      { data: null, error: null },
      // 9b: relink voucher links original → corrected (thenable, #2364)
      { data: null, error: null },
      // 10: relink documents original → corrected (thenable)
      { data: null, error: null },
      // 11: fetch final reversal (.single())
      { data: { ...reversalEntry, lines: [] }, error: null },
      // 12: fetch final corrected (.single())
      { data: { ...correctedEntry, lines: correctedLines }, error: null },
    ]
  }

  // WHO on the two new verifikat: both are posted through commit_journal_entry
  // (commitStornoOrCorrectionDraft), which draws the number and stamps the
  // acting user, key, OAuth client or cron job, instead of a client-side
  // status update that left committed_actor_* NULL and the audit row 'user'.
  it('posts the storno and then the rättelse through the commit RPC, as unnumbered drafts', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    expect(vi.mocked(commitStornoOrCorrectionDraft).mock.calls).toEqual([
      [supabase, 'company-1', 'reversal-1'],
      [supabase, 'company-1', 'corrected-1'],
    ])
    const headers = inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as Record<string, unknown>)
    expect(headers.map((h) => [h.source_type, h.status, h.voucher_number])).toEqual([
      ['storno', 'draft', 0],
      ['correction', 'draft', 0],
    ])
    // The stamp is the commit's own: nothing about the original's commit is
    // written onto the new headers.
    for (const header of headers) {
      expect(header).not.toHaveProperty('committed_actor_type')
      expect(header).not.toHaveProperty('commit_method')
    }
  })

  it('cancels the storno and posts no rättelse when the commit RPC refuses the storno', async () => {
    setupResults()
    results[4] = { data: null, error: { message: 'balance trigger refused' } }
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)

    expect(cancelOrphanedEntry).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'reversal-1')
    expect(commitStornoOrCorrectionDraft).toHaveBeenCalledTimes(1)
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(1)
  })

  it('creates reversal with swapped debit/credit lines', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal).toBeDefined()
    expect(result.reversal.reverses_id).toBe('orig-1')
  })

  // A rättelse in a locked or closed year: the period-lock trigger refused the
  // storno insert only after next_voucher_number had moved on, leaving an
  // undocumented gap (BFNAR 2013:2). Now refused before any number is drawn.
  it('refuses a correction in a locked year before drawing a voucher number', async () => {
    setupResults()
    const refusal = new TargetPeriodLockedError(originalEntry.entry_date, '2026-01-20T10:00:00Z')
    mockAssertStornoTarget.mockRejectedValueOnce(refusal)
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines),
    ).rejects.toBe(refusal)

    // Without inFirstOpenPeriodWhenLocked the storno is never moved.
    expect(mockAssertStornoTarget).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ id: 'orig-1', fiscal_period_id: 'fp-1' }),
      undefined,
      undefined,
    )
    expect(commitStornoOrCorrectionDraft).not.toHaveBeenCalled()
    expect(inserts.filter((i) => i.table === 'journal_entries')).toEqual([])
  })

  // The person's doors (inFirstOpenPeriodWhenLocked): a verifikat in a locked
  // or closed year is corrected by a storno and a corrected verifikat dated
  // in the first open period, naming the original, and nothing is written to
  // the original or its year.
  describe('an original whose own date is locked (moved storno)', () => {
    const MOVED = { date: '2026-11-24', fiscal_period_id: 'fp-2026', moved: true }

    function setupMovedResults() {
      const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1', fiscal_period_id: 'fp-2026' })
      const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1', fiscal_period_id: 'fp-2026' })
      results = [
        // 0: fetch original (.single())
        { data: { ...originalEntry, voucher_number: 12, entry_date: '2025-03-15' }, error: null },
        // 1: the corrected verifikat's year, its date checked inside it
        { data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null },
        // 2: fetch accounts for corrected lines
        { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null },
        // 3: insert reversal entry (.single())
        { data: reversalEntry, error: null },
        // 4: insert reversal lines
        { data: null, error: null },
        // 5: post reversal
        { data: null, error: null },
        // 6: insert corrected entry (.single())
        { data: correctedEntry, error: null },
        // 7: insert corrected lines
        { data: null, error: null },
        // 8: post corrected
        { data: null, error: null },
        // 9: fetch final reversal
        { data: { ...reversalEntry, lines: [] }, error: null },
        // 10: fetch final corrected
        { data: { ...correctedEntry, lines: correctedLines }, error: null },
      ]
    }

    it('dates both new verifikat in the first open period, names the original, and writes nothing to it', async () => {
      setupMovedResults()
      mockAssertStornoTarget.mockResolvedValueOnce(MOVED)
      const supabase = makeClient()

      const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
        inFirstOpenPeriodWhenLocked: true,
      })

      expect(mockAssertStornoTarget).toHaveBeenCalledWith(
        supabase,
        'company-1',
        expect.objectContaining({ id: 'orig-1' }),
        undefined,
        { inFirstOpenPeriodWhenLocked: true },
      )
      const headers = inserts
        .filter((i) => i.table === 'journal_entries')
        .map((i) => i.payload as Record<string, unknown>)
      expect(headers).toEqual([
        expect.objectContaining({
          source_type: 'storno',
          reverses_id: 'orig-1',
          fiscal_period_id: 'fp-2026',
          entry_date: '2026-11-24',
          description: 'Storno av verifikat A12 (2025-03-15): Test purchase',
        }),
        expect.objectContaining({
          source_type: 'correction',
          correction_of_id: 'orig-1',
          fiscal_period_id: 'fp-2026',
          entry_date: '2026-11-24',
          description: 'Rättelse av verifikat A12 (2025-03-15): Test purchase',
        }),
      ])
      expect(mockIsStandingStorno).toHaveBeenCalledWith(supabase, 'company-1', 'orig-1', 'reversal-1')
      // No compare-and-set on the original, no relink out of its year.
      expect(mockRelinkPaymentRows).not.toHaveBeenCalled()
      expect(mockRelinkBookedRecords).not.toHaveBeenCalled()
      expect(supabase.rpc).not.toHaveBeenCalledWith('relink_documents_to_correction', expect.anything())
      expect(vi.mocked(supabase.from).mock.calls.map(([table]) => table)).not.toContain('transactions')
      expect(resultIdx).toBe(11)
      expect(result.reversal.id).toBe('reversal-1')
      expect(result.corrected.id).toBe('corrected-1')
      expect(result).not.toHaveProperty('transactionRelinkError')
      expect(result).not.toHaveProperty('documentRelinkError')
      expect(result).not.toHaveProperty('recordRelinkError')
    })

    it('keeps the person\'s own text and puts the reference after it', async () => {
      setupMovedResults()
      mockAssertStornoTarget.mockResolvedValueOnce(MOVED)
      const supabase = makeClient()

      await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
        inFirstOpenPeriodWhenLocked: true,
        description: 'Kontorsmaterial, rätt konto',
      })

      const corrected = inserts
        .filter((i) => i.table === 'journal_entries')
        .map((i) => i.payload as Record<string, unknown>)[1]
      expect(corrected.description).toBe('Kontorsmaterial, rätt konto (rättelse av verifikat A12 (2025-03-15))')
    })

    it('cancels its storno and posts no rättelse when another storno stands for the original', async () => {
      setupMovedResults()
      mockAssertStornoTarget.mockResolvedValueOnce(MOVED)
      mockIsStandingStorno.mockResolvedValueOnce(false)
      const supabase = makeClient()

      await expect(
        correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
          inFirstOpenPeriodWhenLocked: true,
        }),
      ).rejects.toBeInstanceOf(EntryAlreadyReversedError)

      expect(cancelOrphanedEntry).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'reversal-1')
      expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(1)
    })

    it('says so when the storno that does not stand cannot be cancelled', async () => {
      setupMovedResults()
      mockAssertStornoTarget.mockResolvedValueOnce(MOVED)
      mockIsStandingStorno.mockResolvedValueOnce(false)
      vi.mocked(cancelOrphanedEntry).mockResolvedValueOnce({ error: { message: 'refused' } } as never)
      const supabase = makeClient()

      const err = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
        inFirstOpenPeriodWhenLocked: true,
      }).catch((e) => e)

      expect(err).toBeInstanceOf(BookkeepingDatabaseError)
      expect(String(err.cause)).toContain('reversal-1')
      expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(1)
    })

    it('refuses the same lines again: the original still stands in its year', async () => {
      setupMovedResults()
      mockAssertStornoTarget.mockResolvedValueOnce(MOVED)
      const supabase = makeClient()

      const err = await correctEntry(
        supabase as never,
        'company-1',
        'user-1',
        'orig-1',
        originalEntry.lines!.map((l) => ({
          account_number: l.account_number,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
        })),
        { inFirstOpenPeriodWhenLocked: true },
      ).catch((e) => e)

      expect(err).toBeInstanceOf(MeaninglessCorrectionError)
      expect(err.reason).toBe('identical_to_original')
      expect(inserts).toEqual([])
    })
  })

  // A line booked before the non-negative CHECK (debit -0.25) used to be
  // swapped as is into the storno (credit -0.25), which the CHECK refuses:
  // the rättelse failed where a plain storno worked. Both now build the
  // storno with buildStornoLines.
  it('writes the storno of a legacy negative-side line as a positive line on the opposite side', async () => {
    setupResults()
    results[0] = {
      data: {
        ...originalEntry,
        lines: [
          makeJournalEntryLine({ account_number: '5410', debit_amount: 1000.25, credit_amount: 0 }),
          makeJournalEntryLine({ account_number: '3740', debit_amount: -0.25, credit_amount: 0 }),
          makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
        ],
      },
      error: null,
    }
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const reversalLines = inserts.find((i) => i.table === 'journal_entry_lines')!.payload as Array<{
      account_number: string
      debit_amount: number
      credit_amount: number
      line_description: string
    }>
    expect(reversalLines.map(({ account_number, debit_amount, credit_amount }) => ({ account_number, debit_amount, credit_amount }))).toEqual([
      { account_number: '5410', debit_amount: 0, credit_amount: 1000.25 },
      { account_number: '3740', debit_amount: 0.25, credit_amount: 0 },
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
    ])
    expect(reversalLines.every((l) => l.line_description.startsWith('Storno: '))).toBe(true)
  })

  // #3517: a foreign line whose amount_in_currency is 0 (a revaluation leg on
  // a USD cash account) keeps 0 on both new verifikat; null made it
  // unconvertible in the account's reconciliation.
  it('keeps amount_in_currency 0 on foreign lines of the storno and the rättelse', async () => {
    setupResults()
    results[0] = {
      data: {
        ...originalEntry,
        lines: [
          makeJournalEntryLine({ account_number: '1932', debit_amount: 812.4, credit_amount: 0, currency: 'USD', amount_in_currency: 0 }),
          makeJournalEntryLine({ account_number: '3960', debit_amount: 0, credit_amount: 812.4, currency: 'SEK', amount_in_currency: null }),
        ],
      },
      error: null,
    }
    results[1] = {
      data: [{ id: 'acc-1932', account_number: '1932' }, { id: 'acc-3960', account_number: '3960' }],
      error: null,
    }
    const revaluation = [
      { account_number: '1932', debit_amount: 790.1, credit_amount: 0, currency: 'USD', amount_in_currency: 0 },
      { account_number: '3960', debit_amount: 0, credit_amount: 790.1, currency: 'SEK', amount_in_currency: 0 },
    ]
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', revaluation)

    const [storno, corrected] = inserts
      .filter((i) => i.table === 'journal_entry_lines')
      .map((i) => i.payload as Array<{ account_number: string; currency: string; amount_in_currency: number | null }>)
    const pick = (lines: typeof storno) => lines.map((l) => [l.account_number, l.currency, l.amount_in_currency])
    expect(pick(storno)).toEqual([['1932', 'USD', 0], ['3960', 'SEK', null]])
    expect(pick(corrected)).toEqual([['1932', 'USD', 0], ['3960', 'SEK', null]])
    expect(Object.is(storno[0].amount_in_currency, 0)).toBe(true)
  })

  it('stores the corrected lines as the balance check read them: a half öre up', async () => {
    setupResults()
    const lines = [
      { account_number: '5420', debit_amount: 1.005, credit_amount: 0, currency: 'USD', amount_in_currency: 10.075 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1.01 },
    ]
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', lines)

    const [, corrected] = inserts
      .filter((i) => i.table === 'journal_entry_lines')
      .map((i) => i.payload as Array<{ debit_amount: number; credit_amount: number; amount_in_currency: number | null }>)
    expect(corrected.map((l) => [l.debit_amount, l.credit_amount, l.amount_in_currency])).toEqual([
      [1.01, 0, 10.08],
      [0, 1.01, null],
    ])
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
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },          // 2: insert reversal
      { data: null, error: null },                   // 3: insert reversal lines
      { data: null, error: null },                   // 4: post reversal
      { data: correctedEntry, error: null },         // 5: insert corrected
      { data: null, error: null },                   // 6: insert corrected lines
      { data: null, error: null },                   // 7: post corrected
      { data: [], error: null },                     // 8: CAS fails: empty array
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow('already reversed')

    // Both posted orphans go through the gated cleanup door (a direct
    // posted -> cancelled UPDATE is refused by the database).
    expect(vi.mocked(cancelOrphanedEntry).mock.calls).toEqual([
      [supabase, 'company-1', 'user-1', 'reversal-1'],
      [supabase, 'company-1', 'user-1', 'corrected-1'],
    ])
  })

  it('treats an ambiguous CAS error that did land as a completed correction', async () => {
    setupResults()
    // 8: the CAS reports an error although the UPDATE committed; then the
    // re-read of the original shows it pointing at our reversal.
    results.splice(8, 1,
      { data: null, error: { message: 'fetch failed' } },
      { data: { status: 'reversed', reversed_by_id: 'reversal-1' }, error: null },
    )
    // The cleanup door refuses the reversal: the original references it.
    vi.mocked(cancelOrphanedEntry).mockResolvedValue({
      error: { message: 'is referenced by another verifikat', code: '55000' },
    })

    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    expect(result.reversal.id).toBe('reversal-1')
    expect(result.corrected.id).toBe('corrected-1')
    // Only the reversal cleanup was attempted; the replacement was never cancelled.
    expect(vi.mocked(cancelOrphanedEntry).mock.calls).toEqual([
      [supabase, 'company-1', 'user-1', 'reversal-1'],
    ])
  })

  it('keeps the replacement posted when the reversal cleanup fails after a lost CAS', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    vi.mocked(cancelOrphanedEntry).mockResolvedValue({
      error: { message: 'fetch failed' },
    })

    results = [
      { data: originalEntry, error: null },         // 0: fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },          // 2: insert reversal
      { data: null, error: null },                   // 3: insert reversal lines
      { data: null, error: null },                   // 4: post reversal
      { data: correctedEntry, error: null },         // 5: insert corrected
      { data: null, error: null },                   // 6: insert corrected lines
      { data: null, error: null },                   // 7: post corrected
      { data: [], error: null },                     // 8: CAS fails: empty array
      { data: { status: 'posted', reversed_by_id: null }, error: null }, // 9: re-read original
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow('already reversed')

    // Cancelling the replacement while the reversal survives would net the
    // original to zero with nothing in its place.
    expect(vi.mocked(cancelOrphanedEntry).mock.calls).toEqual([
      [supabase, 'company-1', 'user-1', 'reversal-1'],
    ])
  })

  it('keeps the original error when the rollback itself is refused', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    vi.mocked(cancelOrphanedEntry).mockResolvedValue({
      error: { message: 'was not posted within the last 15 minutes', code: '55000' },
    })

    results = [
      { data: originalEntry, error: null },          // 0: fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },           // 2: insert reversal
      { data: null, error: null },                    // 3: insert reversal lines
      { data: null, error: null },                    // 4: post reversal
      { data: null, error: { message: 'DB error' } }, // 5: insert corrected FAILS
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
    expect(cancelOrphanedEntry).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'reversal-1')
  })

  it('cancels reversal when corrected entry creation fails', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },          // 0: fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },           // 2: insert reversal
      { data: null, error: null },                    // 3: insert reversal lines
      { data: null, error: null },                    // 4: post reversal
      { data: null, error: { message: 'DB error' } }, // 5: insert corrected FAILS
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
    expect(vi.mocked(cancelOrphanedEntry).mock.calls).toEqual([
      [supabase, 'company-1', 'user-1', 'reversal-1'],
    ])
  })

  it('cancels reversal entry when reversal lines fail', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },           // 0: fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },            // 2: insert reversal
      { data: null, error: { message: 'line error' } }, // 3: insert reversal lines FAILS
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
    expect(vi.mocked(cancelOrphanedEntry).mock.calls).toEqual([
      [supabase, 'company-1', 'user-1', 'reversal-1'],
    ])
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

    // Guard runs before any DB call: original must not be fetched.
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
    // Only the fetch-original result is needed: guard runs right after.
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
    // correctedLines moves expense from 5410 → 5420, net effect per account
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

  it('uses a caller-supplied description for the corrected entry (issue #1031)', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
      description: 'Rättelse: Skulder till närstående personer, kortfristig del',
    })

    const entryInserts = inserts.filter((i) => i.table === 'journal_entries')
    expect(entryInserts).toHaveLength(2)
    const corrected = entryInserts[1].payload as { source_type: string; description: string }
    expect(corrected.source_type).toBe('correction')
    expect(corrected.description).toBe('Rättelse: Skulder till närstående personer, kortfristig del')
  })

  it('falls back to "Rättelse: <original>" when no description is supplied', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const entryInserts = inserts.filter((i) => i.table === 'journal_entries')
    const corrected = entryInserts[1].payload as { source_type: string; description: string }
    expect(corrected.source_type).toBe('correction')
    expect(corrected.description).toBe('Rättelse: Test purchase')
  })

  it('falls back to the auto text when the supplied description is blank', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
      description: '   ',
    })

    const entryInserts = inserts.filter((i) => i.table === 'journal_entries')
    const corrected = entryInserts[1].payload as { description: string }
    expect(corrected.description).toBe('Rättelse: Test purchase')
  })

  it('accepts a source_type=correction entry as the original (chained correction, BFL 5 kap. 5 §)', async () => {
    // The user just corrected entry A → got correction C. They now want to
    // correct C. Service must not care about source_type of the original:
    // status='posted' is the only constraint.
    const correctionAsOriginal = makeJournalEntry({
      id: 'correction-1',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: 'orig-A',
      description: 'Rättelse: Test purchase',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      lines: [
        makeJournalEntryLine({ account_number: '5420', debit_amount: 1200, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1200 }),
      ],
    })
    const secondReversal = makeJournalEntry({ id: 'reversal-2', reverses_id: 'correction-1' })
    const secondCorrection = makeJournalEntry({
      id: 'correction-2',
      correction_of_id: 'correction-1',
      source_type: 'correction',
    })

    results = [
      { data: correctionAsOriginal, error: null },                            // 0: fetch original (the prior correction)
      // 1: chain-depth walker follows correction_of_id to the root (depth 1)
      { data: { id: 'orig-A', correction_of_id: null, reverses_id: null, voucher_series: 'A', voucher_number: 1 }, error: null },
      { data: [{ id: 'acc-5430', account_number: '5430' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 2: accounts (Step 0)
      { data: secondReversal, error: null },                                  // 3: insert reversal
      { data: null, error: null },                                            // 4: insert reversal lines
      { data: null, error: null },                                            // 5: post reversal
      { data: secondCorrection, error: null },                                // 6: insert corrected
      { data: null, error: null },                                            // 7: insert corrected lines
      { data: null, error: null },                                            // 8: post corrected
      { data: [{ id: 'correction-1' }], error: null },                        // 9: CAS update
      { data: null, error: null },                                            // 10: relink transactions
      { data: null, error: null },                                            // relink voucher links original → corrected (thenable, #2364)
      { data: null, error: null },                                            // 11: relink documents
      { data: { ...secondReversal, lines: [] }, error: null },                // 12: fetch final reversal
      { data: { ...secondCorrection, lines: [] }, error: null },              // 13: fetch final corrected
    ]

    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'correction-1', [
      { account_number: '5430', debit_amount: 1500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
    ])

    expect(result.reversal.reverses_id).toBe('correction-1')
    expect(result.corrected.correction_of_id).toBe('correction-1')
    expect(result.corrected.source_type).toBe('correction')
  })

  it('rejects a correction whose target already sits 3 links deep in the chain', async () => {
    // Chain: orig-0 ← c1 ← c2 ← c3 (target). Depth of c3 is 3 → guard fires.
    // Christoffer case 2026-08-11: agents stacked rättelser 10 deep.
    const target = makeJournalEntry({
      id: 'c3',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: 'c2',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      lines: [
        makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
      ],
    })
    results = [
      { data: target, error: null },                                                                                   // 0: fetch original
      { data: { id: 'c2', correction_of_id: 'c1', reverses_id: null, voucher_series: 'A', voucher_number: 3 }, error: null }, // 1: walker hop 1
      { data: { id: 'c1', correction_of_id: 'orig-0', reverses_id: null, voucher_series: 'A', voucher_number: 2 }, error: null }, // 2: walker hop 2
      { data: { id: 'orig-0', correction_of_id: null, reverses_id: null, voucher_series: 'A', voucher_number: 1 }, error: null }, // 3: walker hop 3 (root)
    ]

    const supabase = makeClient()
    const err = await correctEntry(
      supabase as never, 'company-1', 'user-1', 'c3', correctedLines
    ).catch((e) => e)
    expect(err).toBeInstanceOf(CorrectionChainTooDeepError)
    expect(err).toMatchObject({
      code: 'CORRECTION_CHAIN_TOO_DEEP',
      depth: 3,
      chainRootVoucher: 'A1',
    })

    // Guard fires before any write or voucher-number draw.
    expect(inserts).toHaveLength(0)
    expect(commitStornoOrCorrectionDraft).not.toHaveBeenCalled()
  })

  it('allowDeepChain: true bypasses the chain-depth guard without walking the chain', async () => {
    const target = makeJournalEntry({
      id: 'c3',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: 'c2',
      description: 'Test purchase',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      lines: [
        makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
      ],
    })
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'c3' })
    const correctedEntry = makeJournalEntry({ id: 'c4', correction_of_id: 'c3' })
    results = [
      { data: target, error: null },                                         // 0: fetch original (no walker queries)
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts
      { data: reversalEntry, error: null },                                  // 2: insert reversal
      { data: null, error: null },                                           // 3: reversal lines
      { data: null, error: null },                                           // 4: post reversal
      { data: correctedEntry, error: null },                                 // 5: insert corrected
      { data: null, error: null },                                           // 6: corrected lines
      { data: null, error: null },                                           // 7: post corrected
      { data: [{ id: 'c3' }], error: null },                                 // 8: CAS
      { data: null, error: null },                                           // 9: relink transactions
      { data: null, error: null },                                           // relink voucher links original → corrected (thenable, #2364)
      { data: null, error: null },                                           // 10: relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },                // 11: final reversal
      { data: { ...correctedEntry, lines: [] }, error: null },               // 12: final corrected
    ]

    const supabase = makeClient()
    const result = await correctEntry(
      supabase as never, 'company-1', 'user-1', 'c3', correctedLines, { allowDeepChain: true }
    )
    expect(result.corrected.id).toBe('c4')
  })

  it('fails fast on unknown accounts: BEFORE the storno exists or a voucher number is consumed', async () => {
    // Regression: the old flow created+posted the storno first, then hit
    // AccountsNotInChartError on the corrected lines and had to cancel the
    // storno again, leaving a voided 0 kr storno in the chain (the user's
    // "A98") and burning voucher numbers (the missing "A99").
    results = [
      { data: originalEntry, error: null }, // 0: fetch original
      { data: [{ id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts: 5420 missing
    ]
    mockBackfill.mockResolvedValue([]) // not seedable (e.g. deactivated / unknown)

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toMatchObject({ code: 'ACCOUNTS_NOT_IN_CHART' })

    // Nothing was written to the journal and no voucher number was fetched.
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
    expect(inserts.filter((i) => i.table === 'journal_entry_lines')).toHaveLength(0)
    expect(commitStornoOrCorrectionDraft).not.toHaveBeenCalled()
  })

  it('seeds a standard BAS account missing from the chart and proceeds', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    results = [
      { data: originalEntry, error: null },                                  // 0: fetch original
      { data: [{ id: 'acc-1930', account_number: '1930' }], error: null },   // 1: accounts: 5420 missing
      // -- backfill seeds 5420 --
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 2: re-resolve
      { data: reversalEntry, error: null },                                  // 3: insert reversal
      { data: null, error: null },                                           // 4: reversal lines
      { data: null, error: null },                                           // 5: post reversal
      { data: correctedEntry, error: null },                                 // 6: insert corrected
      { data: null, error: null },                                           // 7: corrected lines
      { data: null, error: null },                                           // 8: post corrected
      { data: [{ id: 'orig-1' }], error: null },                             // 9: CAS
      { data: null, error: null },                                           // 10: relink transactions
      { data: null, error: null },                                           // relink voucher links original → corrected (thenable, #2364)
      { data: null, error: null },                                           // 11: relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },                // 12: final reversal
      { data: { ...correctedEntry, lines: [] }, error: null },               // 13: final corrected
    ]
    mockBackfill.mockResolvedValue(['5420'])

    const supabase = makeClient()
    const result = await correctEntry(
      supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines
    )
    expect(result.corrected.id).toBe('corrected-1')
    expect(mockBackfill).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', ['5420'])
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
    expect(handler.mock.calls[0]![0]).not.toHaveProperty('keepLearnedTemplates')
  })

  it('carries keepLearnedTemplates on the corrected event when the caller is a system step (crm#1858)', async () => {
    setupResults()

    const handler = vi.fn()
    eventBus.on('journal_entry.corrected', handler)

    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, { keepLearnedTemplates: true })

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ keepLearnedTemplates: true }))
  })

  // accounted#58: reverseEntry announces its storno as committed; correctEntry
  // posts two verifikat and announced neither, so committed webhooks missed them.
  it('emits journal_entry.committed for the storno and the corrected verifikat, before corrected', async () => {
    setupResults()

    const order: string[] = []
    const committed = vi.fn((payload: { entry: { id: string } }) => { order.push(`committed:${payload.entry.id}`) })
    eventBus.on('journal_entry.committed', committed)
    eventBus.on('journal_entry.corrected', () => { order.push('corrected') })

    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    expect(committed).toHaveBeenCalledTimes(2)
    expect(committed).toHaveBeenCalledWith({ entry: result.reversal, userId: 'user-1', companyId: 'company-1' })
    expect(committed).toHaveBeenCalledWith({ entry: result.corrected, userId: 'user-1', companyId: 'company-1' })
    expect(order).toEqual([`committed:${result.reversal.id}`, `committed:${result.corrected.id}`, 'corrected'])
  })

  // #2364: a bank row has two anchors (transactions.journal_entry_id and the
  // transaction_voucher_links junction). Both must follow the correction, or
  // the original keeps its link and the row reads double-anchored.
  describe('bank anchors follow the correction (#2364)', () => {
    type MockClient = ReturnType<typeof makeClient>

    function updatesOn(supabase: MockClient, table: string) {
      return supabase.from.mock.calls.flatMap((call, i) => {
        if (call[0] !== table) return []
        const b = supabase.from.mock.results[i]!.value as Record<string, ReturnType<typeof vi.fn>>
        return b.update.mock.calls.map((u) => ({ payload: u[0], eqs: b.eq.mock.calls }))
      })
    }

    it('re-points the original entry\'s transaction_voucher_links rows to the corrected entry, scoped by company', async () => {
      setupResults()
      const supabase = makeClient()
      const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      const junction = updatesOn(supabase, 'transaction_voucher_links')
      expect(junction).toHaveLength(1)
      expect(junction[0]!.payload).toEqual({ journal_entry_id: 'corrected-1' })
      expect(junction[0]!.eqs).toEqual([
        ['company_id', 'company-1'],
        ['journal_entry_id', 'orig-1'],
      ])
      // The pointer column still follows the correction the way it always did.
      const pointer = updatesOn(supabase, 'transactions')
      expect(pointer).toHaveLength(1)
      expect(pointer[0]!.payload).toEqual({ journal_entry_id: 'corrected-1' })
      expect(result.transactionRelinkError).toBeUndefined()
      // Everything moved: nothing is left on the original to release.
      expect(releaseBankRowsOfReversedEntry).not.toHaveBeenCalled()
    })

    // PH 227: the invoice payment rows follow the bank rows to the corrected
    // verifikat instead of staying on the reversed original.
    it('hands the original and the corrected entry to the payment row relink', async () => {
      setupResults()
      const supabase = makeClient()
      await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      expect(mockRelinkPaymentRows).toHaveBeenCalledTimes(1)
      expect(mockRelinkPaymentRows).toHaveBeenCalledWith(supabase, 'company-1', 'orig-1', 'corrected-1')
    })

    // The records the original books follow as well, each by its own
    // verifikat pointer: the corrected verifikat is the one that books them now.
    it('hands the original and the corrected entry to the relink of the records it books', async () => {
      setupResults()
      const supabase = makeClient()
      await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      expect(mockRelinkBookedRecords).toHaveBeenCalledTimes(1)
      expect(mockRelinkBookedRecords).toHaveBeenCalledWith(supabase, 'company-1', 'orig-1', 'corrected-1')
    })

    it('keeps the posted correction when the relink of the records it books fails', async () => {
      setupResults()
      mockRelinkBookedRecords.mockResolvedValueOnce('KONTANTMETOD_CARRY_LINK_LOCKED')
      const supabase = makeClient()
      const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      expect(result.reversal.id).toBe('reversal-1')
      expect(result.corrected.id).toBe('corrected-1')
      // The failure is on the result, like the bank row and underlag relinks.
      expect(result.recordRelinkError).toBe('KONTANTMETOD_CARRY_LINK_LOCKED')
      // The underlag still follows: the relinks do not depend on each other.
      expect(supabase.rpc).toHaveBeenCalledWith('relink_documents_to_correction', expect.anything())
    })

    it('surfaces a payment row relink failure on the result the same way', async () => {
      setupResults()
      mockRelinkPaymentRows.mockResolvedValueOnce('permission denied for table invoice_payments')
      const supabase = makeClient()
      const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      expect(result.corrected.id).toBe('corrected-1')
      expect(result.recordRelinkError).toBe('permission denied for table invoice_payments')
    })

    it('surfaces a junction relink failure on the result instead of throwing (correction chain stays traceable)', async () => {
      setupResults()
      results[10] = { data: null, error: { message: 'permission denied for table transaction_voucher_links' } }
      const supabase = makeClient()
      const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      expect(result.corrected.id).toBe('corrected-1')
      expect(result.transactionRelinkError).toBe('permission denied for table transaction_voucher_links')
      expect(releaseBankRowsOfReversedEntry).toHaveBeenCalledWith(supabase, 'company-1', 'orig-1')
    })

    it('surfaces a pointer relink failure the same way and still attempts the junction relink', async () => {
      setupResults()
      results[9] = { data: null, error: { message: 'pointer relink failed' } }
      const supabase = makeClient()
      const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      expect(result.transactionRelinkError).toBe('pointer relink failed')
      expect(updatesOn(supabase, 'transaction_voucher_links')).toHaveLength(1)
    })

    it('releases the bank row back to Att bokföra when the correction no longer books its bank leg (crm#1433)', async () => {
      // A purchase booked from the bank row (cost / 1930) corrected into a
      // supplier invoice (cost / 2440): guard_cash_transaction_binding refuses
      // to anchor the row on a verifikat without its bank leg. Before, the row
      // stayed on the reversed original, read as booked, and could be neither
      // unlinked nor stornoed.
      setupResults()
      results[9] = {
        data: null,
        error: { message: 'BANK_ANCHOR_SETTLEMENT_CHANGED', code: 'PT409' },
      }
      const supabase = makeClient()
      const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

      expect(result.corrected.id).toBe('corrected-1')
      expect(releaseBankRowsOfReversedEntry).toHaveBeenCalledTimes(1)
      expect(releaseBankRowsOfReversedEntry).toHaveBeenCalledWith(supabase, 'company-1', 'orig-1')
    })

    it('refuses a correction that moves the bank leg to another bank account before anything is written', async () => {
      // 1930 to 1931: the bank row says the money moved on 1930. Released, the
      // row would invite booking the same money a second time.
      setupResults()
      const refusal = new CorrectionBankAccountChangedError('1930', ['1931'], 'Behåll beloppet på 1930.')
      mockAssertBankAccount.mockRejectedValueOnce(refusal)
      const movedLines = [
        { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1931', debit_amount: 0, credit_amount: 1000 },
      ]
      const supabase = makeClient()

      await expect(
        correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', movedLines),
      ).rejects.toBe(refusal)
      expect(mockAssertBankAccount).toHaveBeenCalledWith(
        supabase,
        'company-1',
        'orig-1',
        originalEntry.lines,
        movedLines,
      )
      expect(inserts).toEqual([])
      expect(commitStornoOrCorrectionDraft).not.toHaveBeenCalled()
      expect(releaseBankRowsOfReversedEntry).not.toHaveBeenCalled()
    })
  })
})

describe('correctEntry: date/period override (recordate engine)', () => {
  const originalEntry = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Webbhotell',
    entry_date: '2024-06-15',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  // Same multiset as the original: allowed here because the *date* is the
  // change (a wrong-year fix keeps the lines untouched).
  const identicalLines = [
    { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
  ]

  it('re-books the corrected entry in the target period/date while the storno stays in the original period', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    results = [
      { data: originalEntry, error: null },                                                          // 0 fetch original
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }, error: null },  // 1 target period
      { data: [{ id: 'acc-5410', account_number: '5410' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 2 accounts (Step 0)
      { data: reversalEntry, error: null },                                                          // 3 insert reversal
      { data: null, error: null },                                                                   // 4 reversal lines
      { data: null, error: null },                                                                   // 5 post reversal
      { data: correctedEntry, error: null },                                                         // 6 insert corrected
      { data: null, error: null },                                                                   // 7 corrected lines
      { data: null, error: null },                                                                   // 8 post corrected
      { data: [{ id: 'orig-1' }], error: null },                                                     // 9 CAS
      { data: null, error: null },                                                                   // 10 relink transactions
      { data: null, error: null },                                                                   // relink voucher links original → corrected (thenable, #2364)
      { data: null, error: null },                                                                   // 11 relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },                                        // 12 final reversal
      { data: { ...correctedEntry, lines: [] }, error: null },                                       // 13 final corrected
    ]
    const supabase = makeClient()
    const result = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      'orig-1',
      identicalLines,
      { newEntryDate: '2025-06-15', newFiscalPeriodId: 'fp-2' }
    )
    expect(result.corrected).toBeDefined()

    const je = inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as { source_type: string; fiscal_period_id: string; entry_date: string })
    expect(je).toHaveLength(2)
    expect(je[0]).toMatchObject({ source_type: 'storno', fiscal_period_id: 'fp-1', entry_date: '2024-06-15' })
    expect(je[1]).toMatchObject({ source_type: 'correction', fiscal_period_id: 'fp-2', entry_date: '2025-06-15' })
  })

  it('rejects when the new date falls outside the target period bounds', async () => {
    results = [
      { data: originalEntry, error: null },                                                          // 0 fetch original
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-05-31' }, error: null },  // 1 target period: 06-15 out of bounds
    ]
    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines, {
        newEntryDate: '2025-06-15',
        newFiscalPeriodId: 'fp-2',
      })
    ).rejects.toMatchObject({ code: 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD' })

    // No storno should have been written.
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('rejects when the target period cannot be found', async () => {
    results = [
      { data: originalEntry, error: null },           // 0 fetch original
      { data: null, error: { message: 'no rows' } },  // 1 target period missing
    ]
    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines, {
        newEntryDate: '2025-06-15',
        newFiscalPeriodId: 'fp-2',
      })
    ).rejects.toMatchObject({ code: 'FISCAL_PERIOD_NOT_FOUND' })
  })
})

/**
 * A rättelse is the same affärshändelse booked right: what the user said
 * about the event follows it onto the correcting verifikat. The note was
 * dropped on every correction because the header listed the columns to copy
 * and `notes` was never listed (crm#1078). The last two tests guard the
 * class: the header is built from CORRECTION_COLUMN_POLICY, so a column is
 * carried or left behind on purpose.
 */
describe('correctEntry: the correction keeps what the user said about the event (crm#1078)', () => {
  const NOTE = 'Deltagare: två kunder. Syfte: genomgång av avtalet.'
  const correctedLines = [
    { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1200 },
  ]

  function original(notes: string | null) {
    return makeJournalEntry({
      id: 'orig-1',
      status: 'posted',
      description: 'Lunch',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      notes,
      lines: [
        makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
      ],
    })
  }

  function fullRunResults(originalEntry: ReturnType<typeof makeJournalEntry>) {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    return [
      { data: originalEntry, error: null }, // fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null },
      { data: reversalEntry, error: null }, // insert reversal
      { data: null, error: null }, // reversal lines
      { data: null, error: null }, // post reversal
      { data: correctedEntry, error: null }, // insert corrected
      { data: null, error: null }, // corrected lines
      { data: null, error: null }, // post corrected
      { data: [{ id: 'orig-1' }], error: null }, // CAS original to reversed
      { data: null, error: null }, // relink transactions
      { data: null, error: null }, // relink voucher links
      { data: null, error: null }, // relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },
      { data: { ...correctedEntry, lines: [] }, error: null },
    ]
  }

  /** [0] is the storno header, [1] the correction header. */
  function headerInserts() {
    return inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as Record<string, unknown>)
  }

  it('carries the note of the corrected verifikat onto the correction', async () => {
    results = fullRunResults(original(NOTE))
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const [, correction] = headerInserts()
    expect(correction.source_type).toBe('correction')
    expect(correction.notes).toBe(NOTE)
  })

  it('keeps the note when the caller rewrites the verifikationstext', async () => {
    results = fullRunResults(original(NOTE))
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
      description: 'Rättelse: representation',
    })

    const [, correction] = headerInserts()
    expect(correction.description).toBe('Rättelse: representation')
    expect(correction.notes).toBe(NOTE)
  })

  it('writes no note on the storno: it cancels the event, it is not the event', async () => {
    results = fullRunResults(original(NOTE))
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const [storno] = headerInserts()
    expect(storno.source_type).toBe('storno')
    expect(storno).not.toHaveProperty('notes')
  })

  it('leaves the correction without a note when the original has none', async () => {
    results = fullRunResults(original(null))
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const [, correction] = headerInserts()
    expect(correction.notes).toBeNull()
  })

  it('carries the note from an original the caller already loaded (the recordate path)', async () => {
    const preloaded = original(NOTE)
    // No fetch of the original: the sequence starts at the target period.
    results = [
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }, error: null },
      ...fullRunResults(preloaded).slice(1),
    ]
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
      newEntryDate: '2025-06-15',
      newFiscalPeriodId: 'fp-2',
      preloadedOriginal: preloaded,
    })

    const [, correction] = headerInserts()
    expect(correction).toMatchObject({ entry_date: '2025-06-15', fiscal_period_id: 'fp-2', notes: NOTE })
  })

  const columnsWithPolicy = (...policies: string[]) =>
    Object.entries(CORRECTION_COLUMN_POLICY)
      .filter(([, policy]) => policies.includes(policy))
      .map(([column]) => column)
      .sort()

  it('builds the correction header from exactly the written and carried columns of the policy', async () => {
    results = fullRunResults(original(NOTE))
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    // A column added to the insert must be classified, and a column classified
    // as written or carried must reach the insert: the table and the code
    // cannot drift apart.
    const [, correction] = headerInserts()
    expect(Object.keys(correction).sort()).toEqual(columnsWithPolicy('written', 'carried'))
  })

  it('carries every column the policy marks as carried, whatever it holds', async () => {
    const carried = columnsWithPolicy('carried')
    expect(carried).toContain('notes')

    const sentinel = Object.fromEntries(carried.map((column) => [column, `carried:${column}`]))
    results = fullRunResults({ ...original(null), ...sentinel } as ReturnType<typeof makeJournalEntry>)
    await correctEntry(makeClient() as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const [, correction] = headerInserts()
    for (const column of carried) {
      expect(correction[column], column).toBe(`carried:${column}`)
    }
  })
})

/**
 * A wrong tag in a locked period can only be fixed by storno plus
 * correction (the retag path is open-period only), so a correction that
 * changes nothing but a line's dimensions bag is a real change. The bag is
 * compared normalized: key order, '01' vs '1', the deprecated aliases and an
 * empty value vs a missing key are not differences.
 */
describe('correctEntry: dimension-only corrections', () => {
  const taggedOriginal = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Material',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({
        account_number: '4010',
        debit_amount: 1000,
        credit_amount: 0,
        dimensions: { '1': 'KS01', '6': 'P001' },
      }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  function fullRunResults() {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    return [
      { data: taggedOriginal, error: null }, // fetch original
      { data: [{ id: 'acc-4010', account_number: '4010' }, { id: 'acc-1930', account_number: '1930' }], error: null },
      { data: reversalEntry, error: null }, // insert reversal
      { data: null, error: null }, // reversal lines
      { data: null, error: null }, // post reversal
      { data: correctedEntry, error: null }, // insert corrected
      { data: null, error: null }, // corrected lines
      { data: null, error: null }, // post corrected
      { data: [{ id: 'orig-1' }], error: null }, // CAS original to reversed
      { data: null, error: null }, // relink transactions
      { data: null, error: null }, // relink voucher links
      { data: null, error: null }, // relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },
      { data: { ...correctedEntry, lines: [] }, error: null },
    ]
  }

  it('accepts a correction that only moves a line to another project', async () => {
    results = fullRunResults()
    const supabase = makeClient()
    const retagged = [
      { account_number: '4010', debit_amount: 1000, credit_amount: 0, dimensions: { '1': 'KS01', '6': 'P002' } },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', retagged)

    expect(result.corrected).toBeDefined()
    const correctedLineInsert = inserts
      .filter((i) => i.table === 'journal_entry_lines')
      .map((i) => i.payload as Array<{ account_number: string; dimensions: Record<string, string> }>)[1]
    expect(correctedLineInsert.find((l) => l.account_number === '4010')?.dimensions).toEqual({
      '1': 'KS01',
      '6': 'P002',
    })
  })

  it('accepts a correction that only removes a tag', async () => {
    results = fullRunResults()
    const supabase = makeClient()
    const untagged = [
      { account_number: '4010', debit_amount: 1000, credit_amount: 0, dimensions: { '1': 'KS01' } },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', untagged)

    expect(result.corrected).toBeDefined()
  })

  it('still rejects lines identical up to key order, aliases, leading zeros and empty values', async () => {
    const supabase = makeClient()
    results = [{ data: taggedOriginal, error: null }]
    const sameBag: CreateJournalEntryLineInput[] = [
      {
        account_number: '4010',
        debit_amount: 1000,
        credit_amount: 0,
        cost_center: 'KS01',
        dimensions: { '06': 'P001', '7': '' },
      },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000, dimensions: {} },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', sameBag)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'identical_to_original',
    })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })
})

/**
 * crm#2161: a 1510 line booked without the invoice's currency cannot be
 * linked to a foreign-currency invoice (LINK_VOUCHER_CURRENCY_MISMATCH). The
 * rättelse that adds the currency kept the accounts and kronor, so it was
 * refused as "identical to the original" and the only way out was a storno
 * and a new voucher by hand.
 */
describe('correctEntry: currency-only corrections (crm#2161)', () => {
  const sekOriginal = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Kundbetalning',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1510', debit_amount: 0, credit_amount: 1129 }),
    ],
  })

  function fullRunResults(original = sekOriginal) {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    return [
      { data: original, error: null }, // fetch original
      { data: [{ id: 'acc-2999', account_number: '2999' }, { id: 'acc-1510', account_number: '1510' }], error: null },
      { data: reversalEntry, error: null }, // insert reversal
      { data: null, error: null }, // reversal lines
      { data: null, error: null }, // post reversal
      { data: correctedEntry, error: null }, // insert corrected
      { data: null, error: null }, // corrected lines
      { data: null, error: null }, // post corrected
      { data: [{ id: 'orig-1' }], error: null }, // CAS original to reversed
      { data: null, error: null }, // relink transactions
      { data: null, error: null }, // relink voucher links
      { data: null, error: null }, // relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },
      { data: { ...correctedEntry, lines: [] }, error: null },
    ]
  }

  const withEur: CreateJournalEntryLineInput[] = [
    { account_number: '2999', debit_amount: 1129, credit_amount: 0 },
    {
      account_number: '1510',
      debit_amount: 0,
      credit_amount: 1129,
      currency: 'EUR',
      amount_in_currency: 100,
      exchange_rate: 11.29,
    },
  ]

  it('accepts a correction that only gives a line its currency, and stores it', async () => {
    results = fullRunResults()
    const supabase = makeClient()

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', withEur)

    expect(result.corrected).toBeDefined()
    const correctedLineInsert = inserts
      .filter((i) => i.table === 'journal_entry_lines')
      .map((i) => i.payload as Array<{ account_number: string; currency: string; amount_in_currency: number | null; exchange_rate: number | null }>)[1]
    expect(correctedLineInsert.find((l) => l.account_number === '1510')).toMatchObject({
      currency: 'EUR',
      amount_in_currency: 100,
      exchange_rate: 11.29,
    })
  })

  it('accepts a correction that only changes the amount in the currency', async () => {
    const eurOriginal = makeJournalEntry({
      ...sekOriginal,
      lines: [
        makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }),
        makeJournalEntryLine({
          account_number: '1510',
          debit_amount: 0,
          credit_amount: 1129,
          currency: 'EUR',
          amount_in_currency: 90,
          exchange_rate: 12.5444,
        }),
      ],
    })
    results = fullRunResults(eurOriginal)
    const supabase = makeClient()

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', withEur)

    expect(result.corrected).toBeDefined()
  })

  it('still rejects lines whose currency, amount and rate are the stored ones', async () => {
    // Numeric columns arrive as strings.
    const eurOriginal = makeJournalEntry({
      ...sekOriginal,
      lines: [
        makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }),
        makeJournalEntryLine({
          account_number: '1510',
          debit_amount: 0,
          credit_amount: 1129,
          currency: 'EUR',
          amount_in_currency: '100.00' as unknown as number,
          exchange_rate: '11.290000' as unknown as number,
        }),
      ],
    })
    results = [{ data: eurOriginal, error: null }]
    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', withEur)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'identical_to_original',
    })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('still rejects the amounts restated without currency on a foreign-currency original: no silent strip', async () => {
    // The correction dialog sends account, amounts and text only. Restating a
    // EUR line that way is no change, and must not post a kronor copy of it.
    const eurOriginal = makeJournalEntry({
      ...sekOriginal,
      lines: [
        makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }),
        makeJournalEntryLine({
          account_number: '1510',
          debit_amount: 0,
          credit_amount: 1129,
          currency: 'EUR',
          amount_in_currency: 100,
          exchange_rate: 11.29,
        }),
      ],
    })
    results = [{ data: eurOriginal, error: null }]
    const supabase = makeClient()
    const dialogLines: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 1129, credit_amount: 0, line_description: 'Kundbetalning' },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', dialogLines)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'identical_to_original',
    })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('accepts a correction that explicitly sets a foreign line back to kronor', async () => {
    const eurOriginal = makeJournalEntry({
      ...sekOriginal,
      lines: [
        makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }),
        makeJournalEntryLine({
          account_number: '1510',
          debit_amount: 0,
          credit_amount: 1129,
          currency: 'EUR',
          amount_in_currency: 100,
          exchange_rate: 11.29,
        }),
      ],
    })
    results = fullRunResults(eurOriginal)
    const supabase = makeClient()
    const toKronor: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 1129, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129, currency: 'SEK' },
    ]

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', toKronor)

    expect(result.corrected).toBeDefined()
  })

  it('refuses a currency-only correction that leaves out the currency of a foreign line: no silent strip', async () => {
    // A currency stated on the 2999 line makes the correction a change; the
    // 1510 line, restated without its EUR, would post in kronor.
    const eurOriginal = makeJournalEntry({
      ...sekOriginal,
      lines: [
        makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }),
        makeJournalEntryLine({
          account_number: '1510',
          debit_amount: 0,
          credit_amount: 1129,
          currency: 'EUR',
          amount_in_currency: 100,
          exchange_rate: 11.29,
        }),
      ],
    })
    results = [{ data: eurOriginal, error: null }]
    const supabase = makeClient()
    const oneLineLeftOut: CreateJournalEntryLineInput[] = [
      {
        account_number: '2999',
        debit_amount: 1129,
        credit_amount: 0,
        currency: 'EUR',
        amount_in_currency: 100,
        exchange_rate: 11.29,
      },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', oneLineLeftOut)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'currency_incomplete',
    })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('refuses a new rate on one of two foreign lines when the other leaves out its currency', async () => {
    const twoEurLines = makeJournalEntry({
      ...sekOriginal,
      lines: [
        makeJournalEntryLine({ account_number: '2999', debit_amount: 2258, credit_amount: 0 }),
        makeJournalEntryLine({
          account_number: '1510',
          debit_amount: 0,
          credit_amount: 1129,
          currency: 'EUR',
          amount_in_currency: 100,
          exchange_rate: 11.29,
        }),
        makeJournalEntryLine({
          account_number: '1510',
          debit_amount: 0,
          credit_amount: 1129,
          currency: 'EUR',
          amount_in_currency: 100,
          exchange_rate: 11.29,
        }),
      ],
    })
    results = [{ data: twoEurLines, error: null }]
    const supabase = makeClient()
    const proposed: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 2258, credit_amount: 0 },
      {
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 1129,
        currency: 'EUR',
        amount_in_currency: 90,
        exchange_rate: 12.5444,
      },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', proposed)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'currency_incomplete',
    })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  const eurLine = makeJournalEntryLine({
    account_number: '1510',
    debit_amount: 0,
    credit_amount: 1129,
    currency: 'EUR',
    amount_in_currency: 100,
    exchange_rate: 11.29,
  })

  it('still rejects an agent restating a foreign line with nulls coerced to 0: no silent strip', async () => {
    // The MCP doors turn amount_in_currency: null into 0. That is no currency.
    results = [
      {
        data: makeJournalEntry({
          ...sekOriginal,
          lines: [makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }), eurLine],
        }),
        error: null,
      },
    ]
    const supabase = makeClient()
    const coerced: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 1129, credit_amount: 0, amount_in_currency: 0, exchange_rate: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129, amount_in_currency: 0, exchange_rate: 0 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', coerced)
    ).rejects.toMatchObject({ code: 'MEANINGLESS_CORRECTION', reason: 'identical_to_original' })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('refuses a bare line when a same-amount original is foreign, even if another one is kronor', async () => {
    // Which original the bare 1510 restates cannot be told: it may be the EUR one.
    results = [
      {
        data: makeJournalEntry({
          ...sekOriginal,
          lines: [
            makeJournalEntryLine({ account_number: '2999', debit_amount: 2258, credit_amount: 0 }),
            makeJournalEntryLine({ account_number: '1510', debit_amount: 0, credit_amount: 1129 }),
            eurLine,
          ],
        }),
        error: null,
      },
    ]
    const supabase = makeClient()
    const proposed: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 2258, credit_amount: 0 },
      {
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 1129,
        currency: 'EUR',
        amount_in_currency: 90,
        exchange_rate: 12.5444,
      },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', proposed)
    ).rejects.toMatchObject({ code: 'MEANINGLESS_CORRECTION', reason: 'currency_incomplete' })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('refuses a currency-only correction that names a foreign currency without its amount and rate', async () => {
    results = [{ data: sekOriginal, error: null }]
    const supabase = makeClient()
    const codeOnly: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 1129, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129, currency: 'EUR' },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', codeOnly)
    ).rejects.toMatchObject({ code: 'MEANINGLESS_CORRECTION', reason: 'currency_incomplete' })
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('accepts the currency on 1510 when a foreign revaluation leg is restated as it was', async () => {
    const withRevaluationLeg = makeJournalEntry({
      ...sekOriginal,
      lines: [
        makeJournalEntryLine({ account_number: '1932', debit_amount: 1179, credit_amount: 0, currency: 'USD', amount_in_currency: 0 }),
        makeJournalEntryLine({ account_number: '3960', debit_amount: 0, credit_amount: 50 }),
        makeJournalEntryLine({ account_number: '1510', debit_amount: 0, credit_amount: 1129 }),
      ],
    })
    results = fullRunResults(withRevaluationLeg)
    results[1] = {
      data: ['1932', '3960', '1510'].map((n) => ({ id: `acc-${n}`, account_number: n })),
      error: null,
    }
    const supabase = makeClient()
    const proposed: CreateJournalEntryLineInput[] = [
      { account_number: '1932', debit_amount: 1179, credit_amount: 0, currency: 'USD', amount_in_currency: 0 },
      { account_number: '3960', debit_amount: 0, credit_amount: 50 },
      {
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 1129,
        currency: 'EUR',
        amount_in_currency: 100,
        exchange_rate: 11.29,
      },
    ]

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', proposed)

    expect(result.corrected).toBeDefined()
  })

  it('still rejects a lowercase code or a rate on a kronor line as no change', async () => {
    results = [
      {
        data: makeJournalEntry({
          ...sekOriginal,
          lines: [makeJournalEntryLine({ account_number: '2999', debit_amount: 1129, credit_amount: 0 }), eurLine],
        }),
        error: null,
      },
    ]
    const supabase = makeClient()
    const sameFacts: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 1129, credit_amount: 0, currency: 'sek', exchange_rate: 1 },
      {
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 1129,
        currency: 'eur',
        amount_in_currency: 100,
        exchange_rate: 11.29,
      },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', sameFacts)
    ).rejects.toMatchObject({ code: 'MEANINGLESS_CORRECTION', reason: 'identical_to_original' })
  })

  it('still rejects kronor lines restated with an explicit SEK and no amount in currency', async () => {
    results = [{ data: sekOriginal, error: null }]
    const supabase = makeClient()
    const restated: CreateJournalEntryLineInput[] = [
      { account_number: '2999', debit_amount: 1129, credit_amount: 0, currency: 'SEK', amount_in_currency: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1129, currency: 'SEK' },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', restated)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'identical_to_original',
    })
  })
})

/**
 * crm#1397: "Skapa ändringsverifikation" on a bank fee, with the original's
 * lines swapped to debit/credit as the rättelse. The storno already reverses
 * the original, so the rättelse reversed it a second time and the fee ended
 * at minus 100 kr. crm#1368: the user only wanted the right date.
 */
describe('correctEntry: a rättelse that reverses the original again (crm#1397)', () => {
  const fee = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Bankavgift',
    entry_date: '2026-10-27',
    fiscal_period_id: 'fp-2026',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '6570', debit_amount: 100, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 100 }),
    ],
  })
  const swapped = [
    { account_number: '6570', debit_amount: 0, credit_amount: 100 },
    { account_number: '1930', debit_amount: 100, credit_amount: 0 },
  ]
  const asBooked = [
    { account_number: '6570', debit_amount: 100, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 100 },
  ]

  function fullRunResults(extraBeforeAccounts: Array<{ data?: unknown; error?: unknown }> = []) {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    return [
      { data: fee, error: null }, // fetch original
      ...extraBeforeAccounts,
      { data: [{ id: 'acc-6570', account_number: '6570' }, { id: 'acc-1930', account_number: '1930' }], error: null },
      { data: reversalEntry, error: null }, // insert reversal
      { data: null, error: null }, // reversal lines
      { data: null, error: null }, // post reversal
      { data: correctedEntry, error: null }, // insert corrected
      { data: null, error: null }, // corrected lines
      { data: null, error: null }, // post corrected
      { data: [{ id: 'orig-1' }], error: null }, // CAS original to reversed
      { data: null, error: null }, // relink transactions
      { data: null, error: null }, // relink voucher links
      { data: null, error: null }, // relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },
      { data: { ...correctedEntry, lines: [] }, error: null },
    ]
  }

  function journalEntryInserts() {
    return inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as { source_type: string; entry_date: string; fiscal_period_id: string })
  }

  it('refuses the original with debit and credit swapped before anything is written', async () => {
    results = [{ data: fee, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', swapped)
    ).rejects.toMatchObject({ code: 'MEANINGLESS_CORRECTION', reason: 'negates_original' })

    expect(journalEntryInserts()).toHaveLength(0)
    expect(commitStornoOrCorrectionDraft).not.toHaveBeenCalled()
  })

  it('refuses it however the swapped amounts are split or tagged', async () => {
    results = [{ data: fee, error: null }]
    const supabase = makeClient()
    const splitAndTagged = [
      { account_number: '6570', debit_amount: 0, credit_amount: 60, dimensions: { '6': 'P001' } },
      { account_number: '6570', debit_amount: 0, credit_amount: 40 },
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', splitAndTagged)
    ).rejects.toMatchObject({ reason: 'negates_original' })
    expect(journalEntryInserts()).toHaveLength(0)
  })

  it('refuses it on another date too: a second reversal is not made right by its date', async () => {
    results = [{ data: fee, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', swapped, { newEntryDate: '2026-07-27' })
    ).rejects.toMatchObject({ reason: 'negates_original' })
    expect(mockResolvePeriod).not.toHaveBeenCalled()
    expect(journalEntryInserts()).toHaveLength(0)
  })

  it('posts the swapped lines when the caller says the original had the sides swapped', async () => {
    results = fullRunResults()
    const supabase = makeClient()

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', swapped, {
      sidesSwapped: true,
    })

    expect(result.corrected).toBeDefined()
    const correctedLines = inserts
      .filter((i) => i.table === 'journal_entry_lines')
      .map((i) => i.payload as Array<{ account_number: string; debit_amount: number; credit_amount: number }>)[1]
    expect(correctedLines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6570', 0, 100],
      ['1930', 100, 0],
    ])
  })

  it('moves the rättelse to the date the user gives, in the period that covers it; the storno keeps the original date', async () => {
    mockResolvePeriod.mockResolvedValue({ period_id: 'fp-2026', status: 'open', lock_date: null })
    // fp-2026 still covers the new date: the bounds read after the period is found.
    results = fullRunResults([
      { data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null },
    ])
    const supabase = makeClient()

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', asBooked, {
      newEntryDate: '2026-07-27',
    })

    expect(result.corrected).toBeDefined()
    expect(mockResolvePeriod).toHaveBeenCalledWith(supabase, 'company-1', '2026-07-27')
    expect(journalEntryInserts()).toEqual([
      expect.objectContaining({ source_type: 'storno', entry_date: '2026-10-27', fiscal_period_id: 'fp-2026' }),
      expect.objectContaining({ source_type: 'correction', entry_date: '2026-07-27', fiscal_period_id: 'fp-2026' }),
    ])
  })

  it('refuses a rättelse date in a locked period before anything is written', async () => {
    mockResolvePeriod.mockResolvedValue({ period_id: 'fp-2026', status: 'locked', lock_date: '2026-09-30' })
    results = [{ data: fee, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', asBooked, { newEntryDate: '2026-07-27' })
    ).rejects.toBeInstanceOf(TargetPeriodLockedError)
    expect(journalEntryInserts()).toHaveLength(0)
  })

  it('refuses a rättelse date in a closed year', async () => {
    mockResolvePeriod.mockResolvedValue({ period_id: 'fp-2025', status: 'closed', lock_date: null })
    results = [{ data: fee, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', asBooked, { newEntryDate: '2025-12-27' })
    ).rejects.toBeInstanceOf(TargetPeriodClosedError)
    expect(journalEntryInserts()).toHaveLength(0)
  })

  it('treats the original date as no date change: identical lines are still nothing to correct', async () => {
    results = [{ data: fee, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', asBooked, { newEntryDate: '2026-10-27' })
    ).rejects.toMatchObject({ reason: 'identical_to_original' })
    expect(mockResolvePeriod).not.toHaveBeenCalled()
  })
})

/**
 * Importmoms keeps its ruta 50 base through a rättelse (#94). The booking
 * doors refuse 2615/2625/2635 credited with no 4545-4547 line (#83); a
 * correction that kept or introduced the shape posted it anyway (28 rättelser
 * in production, mostly a cost account changed beside a pre-2015 2615).
 */
describe('correctEntry: importmoms without its ruta 50 base', () => {
  const euPurchaseOn2615 = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'EU-köp',
    entry_date: '2026-03-17',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    source_type: 'bank_transaction',
    lines: [
      makeJournalEntryLine({ account_number: '4515', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '2645', debit_amount: 250, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '2615', debit_amount: 0, credit_amount: 250 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  it('refuses corrected lines that keep 2615 without a base, before the storno is written', async () => {
    results = [{ data: euPurchaseOn2615, error: null }]
    const supabase = makeClient()
    const kept2615 = [
      { account_number: '5460', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2645', debit_amount: 250, credit_amount: 0 },
      { account_number: '2615', debit_amount: 0, credit_amount: 250 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]

    const refusal = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', kept2615).catch((e) => e)

    expect(refusal).toBeInstanceOf(ImportVatWithoutBaseError)
    expect(refusal).toMatchObject({ code: 'IMPORT_VAT_WITHOUT_BASE', importVatAccounts: ['2615'] })
    expect(refusal.message).toContain('rättelsen')
    expect(inserts).toHaveLength(0)
    expect(commitStornoOrCorrectionDraft).not.toHaveBeenCalled()
  })

  it('passes a rättelse that moves the fiktiv moms to 2614 (the importmoms comes out)', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    const to2614 = [
      { account_number: '4515', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2645', debit_amount: 250, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 250 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]
    results = [
      { data: euPurchaseOn2615, error: null },
      { data: to2614.map((l) => ({ id: `acc-${l.account_number}`, account_number: l.account_number })), error: null },
      { data: reversalEntry, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: correctedEntry, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: [{ id: 'orig-1' }], error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { ...reversalEntry, lines: [] }, error: null },
      { data: { ...correctedEntry, lines: to2614 }, error: null },
    ]
    const supabase = makeClient()

    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', to2614)

    expect(result.corrected).toBeDefined()
    // No line credits importmoms: the chart is never read.
    expect(mockFetchDynamic).not.toHaveBeenCalled()
  })

  it('does not judge a pure move: the same lines on another date (recordate)', async () => {
    results = [
      { data: euPurchaseOn2615, error: null },
      // The target period is read next, so the guard let the move through.
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-05-31' }, error: null },
    ]
    const supabase = makeClient()
    const sameLines = euPurchaseOn2615.lines!.map((l) => ({
      account_number: l.account_number,
      debit_amount: Number(l.debit_amount),
      credit_amount: Number(l.credit_amount),
    }))

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', sameLines, {
        newEntryDate: '2025-06-15',
        newFiscalPeriodId: 'fp-2',
      }),
    ).rejects.toMatchObject({ code: 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD' })
    expect(mockFetchDynamic).not.toHaveBeenCalled()
  })
})
