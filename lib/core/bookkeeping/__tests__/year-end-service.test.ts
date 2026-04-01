import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeFiscalPeriod } from '@/tests/helpers'

// ============================================================
// Mock — separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown; count?: number | null }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lte', 'gte', 'in', 'neq', 'not', 'or', 'order', 'limit', 'is']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/currency-revaluation', () => ({
  previewCurrencyRevaluation: vi.fn().mockResolvedValue({
    items: [],
    lines: [],
    closingRates: {},
    totalGain: 0,
    totalLoss: 0,
    netEffect: 0,
  }),
  executeCurrencyRevaluation: vi.fn().mockResolvedValue(null),
}))

vi.mock('../period-service', () => ({
  lockPeriod: vi.fn(),
  closePeriod: vi.fn(),
  createNextPeriod: vi.fn(),
}))

import { validateYearEndReadiness, previewYearEndClosing } from '../year-end-service'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateIncomeStatement } from '@/lib/reports/income-statement'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
})

describe('validateYearEndReadiness', () => {
  // Helper: standard results for no-gap, single-series validation
  function noGapResults(period: ReturnType<typeof makeFiscalPeriod>, overrides: {
    draftCount?: number
    postedCount?: number
    revalCount?: number
    fxReceivables?: number
    fxPayables?: number
  } = {}) {
    return [
      { data: period, error: null },                                          // fetch period (.single)
      { data: null, error: null, count: overrides.draftCount ?? 0 },          // count drafts (thenable)
      { data: [{ voucher_series: 'A' }], error: null },                       // voucher_sequences (thenable)
      { data: [], error: null },                                              // detect_voucher_gaps RPC
      // no gaps → gap_explanations query skipped
      { data: { last_number: 10 }, error: null },                             // reconciliation: voucher_sequences.last_number (.single)
      { data: { voucher_number: 10 }, error: null },                          // reconciliation: journal_entries max (.maybeSingle)
      // trial balance mocked separately
      { data: null, error: null, count: overrides.postedCount ?? 5 },         // count posted (thenable)
      { data: null, error: null, count: overrides.revalCount ?? 0 },          // count revaluation (thenable)
      { data: null, error: null, count: overrides.fxReceivables ?? 0 },       // fx receivables (thenable)
      { data: null, error: null, count: overrides.fxPayables ?? 0 },          // fx payables (thenable)
    ]
  }

  it('returns errors when drafts exist', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })
    results = noGapResults(period, { draftCount: 3, postedCount: 10 })

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 0,
      totalCredit: 0,
    } as never)

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(result.errors.some((e: string) => e.includes('draft'))).toBe(true)
  })

  it('returns errors when trial balance is unbalanced', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })
    results = noGapResults(period)

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: false,
      totalDebit: 10000,
      totalCredit: 9500,
    } as never)

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(result.trialBalanceBalanced).toBe(false)
    expect(result.errors.some((e: string) => e.includes('Trial balance'))).toBe(true)
  })

  it('returns error when period has not yet ended', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      is_closed: false,
      closing_entry_id: null,
      period_end: '2099-12-31',
    })
    results = noGapResults(period)

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 0,
      totalCredit: 0,
    } as never)

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(result.errors.some((e: string) => e.includes('not yet ended'))).toBe(true)
  })

  it('warns on explained voucher gaps', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })

    const builder = makeBuilder()
    const supabase = {
      from: vi.fn().mockImplementation(() => builder),
      rpc: vi.fn().mockResolvedValue({
        data: [{ gap_start: 5, gap_end: 7 }],
        error: null,
      }),
    }

    resultIdx = 0
    results = [
      { data: period, error: null },                                                                          // fetch period
      { data: null, error: null, count: 0 },                                                                  // count drafts
      { data: [{ voucher_series: 'A' }], error: null },                                                       // voucher_sequences
      // rpc for detect_voucher_gaps handled by custom mock
      { data: [{ voucher_series: 'A', gap_start: 5, gap_end: 7 }], error: null },                            // gap_explanations
      { data: { last_number: 10 }, error: null },                                                              // reconciliation: last_number
      { data: { voucher_number: 10 }, error: null },                                                           // reconciliation: max voucher
      { data: null, error: null, count: 5 },                                                                  // count posted
      { data: null, error: null, count: 0 },                                                                  // count revaluation
      { data: null, error: null, count: 0 },                                                                  // fx receivables
      { data: null, error: null, count: 0 },                                                                  // fx payables
    ]

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.warnings.some((w: string) => w.includes('documented'))).toBe(true)
    expect(result.voucherGaps).toHaveLength(1)
    expect(result.voucherGaps[0].series).toBe('A')
    expect(result.unexplainedGaps).toHaveLength(0)
    expect(result.ready).toBe(true)
  })

  it('blocks on unexplained voucher gaps', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })

    const builder = makeBuilder()
    const supabase = {
      from: vi.fn().mockImplementation(() => builder),
      rpc: vi.fn().mockResolvedValue({
        data: [{ gap_start: 5, gap_end: 7 }],
        error: null,
      }),
    }

    resultIdx = 0
    results = [
      { data: period, error: null },                                           // fetch period
      { data: null, error: null, count: 0 },                                   // count drafts
      { data: [{ voucher_series: 'A' }], error: null },                        // voucher_sequences
      // rpc for detect_voucher_gaps handled by custom mock
      { data: [], error: null },                                               // gap_explanations — empty
      { data: { last_number: 10 }, error: null },                              // reconciliation: last_number
      { data: { voucher_number: 10 }, error: null },                           // reconciliation: max voucher
      { data: null, error: null, count: 5 },                                   // count posted
      { data: null, error: null, count: 0 },                                   // count revaluation
      { data: null, error: null, count: 0 },                                   // fx receivables
      { data: null, error: null, count: 0 },                                   // fx payables
    ]

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(result.errors.some((e: string) => e.includes('Unexplained voucher gap'))).toBe(true)
    expect(result.unexplainedGaps).toHaveLength(1)
    expect(result.unexplainedGaps[0]).toEqual({ gap_start: 5, gap_end: 7, series: 'A' })
  })

  it('detects gaps across multiple voucher series', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })

    const builder = makeBuilder()
    let rpcCallCount = 0
    const supabase = {
      from: vi.fn().mockImplementation(() => builder),
      rpc: vi.fn().mockImplementation(() => {
        rpcCallCount++
        if (rpcCallCount === 1) {
          return Promise.resolve({ data: [{ gap_start: 3, gap_end: 3 }], error: null })
        }
        return Promise.resolve({ data: [{ gap_start: 1, gap_end: 2 }], error: null })
      }),
    }

    resultIdx = 0
    results = [
      { data: period, error: null },                                                    // fetch period
      { data: null, error: null, count: 0 },                                            // count drafts
      { data: [{ voucher_series: 'A' }, { voucher_series: 'B' }], error: null },        // voucher_sequences
      // rpc calls handled by custom mock
      { data: [], error: null },                                                         // gap_explanations — empty
      { data: { last_number: 5 }, error: null },                                         // reconciliation A: last_number
      { data: { voucher_number: 5 }, error: null },                                      // reconciliation A: max voucher
      { data: { last_number: 3 }, error: null },                                         // reconciliation B: last_number
      { data: { voucher_number: 3 }, error: null },                                      // reconciliation B: max voucher
      { data: null, error: null, count: 5 },                                            // count posted
      { data: null, error: null, count: 0 },                                            // count revaluation
      { data: null, error: null, count: 0 },                                            // fx receivables
      { data: null, error: null, count: 0 },                                            // fx payables
    ]

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.voucherGaps).toHaveLength(2)
    expect(result.voucherGaps[0]).toEqual({ gap_start: 3, gap_end: 3, series: 'A' })
    expect(result.voucherGaps[1]).toEqual({ gap_start: 1, gap_end: 2, series: 'B' })
    expect(result.unexplainedGaps).toHaveLength(2)
    expect(result.errors.some((e: string) => e.includes('series A'))).toBe(true)
    expect(result.errors.some((e: string) => e.includes('series B'))).toBe(true)
  })

  it('detects sequence counter mismatch (counter < actual)', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })

    results = [
      { data: period, error: null },                                           // fetch period
      { data: null, error: null, count: 0 },                                   // count drafts
      { data: [{ voucher_series: 'A' }], error: null },                        // voucher_sequences
      { data: [], error: null },                                               // detect_voucher_gaps RPC
      // no gaps → gap_explanations skipped
      { data: { last_number: 5 }, error: null },                               // reconciliation: last_number (counter behind!)
      { data: { voucher_number: 10 }, error: null },                           // reconciliation: max voucher
      { data: null, error: null, count: 5 },                                   // count posted
      { data: null, error: null, count: 0 },                                   // count revaluation
      { data: null, error: null, count: 0 },                                   // fx receivables
      { data: null, error: null, count: 0 },                                   // fx payables
    ]

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(result.errors.some((e: string) => e.includes('Sequence counter integrity error'))).toBe(true)
    expect(result.sequenceMismatches).toHaveLength(1)
    expect(result.sequenceMismatches[0]).toEqual({ series: 'A', sequenceCounter: 5, actualMax: 10 })
  })

  it('warns when sequence counter is ahead of actual (burned numbers)', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })

    results = [
      { data: period, error: null },                                           // fetch period
      { data: null, error: null, count: 0 },                                   // count drafts
      { data: [{ voucher_series: 'A' }], error: null },                        // voucher_sequences
      { data: [], error: null },                                               // detect_voucher_gaps RPC
      // no gaps → gap_explanations skipped
      { data: { last_number: 12 }, error: null },                              // reconciliation: last_number (counter ahead)
      { data: { voucher_number: 10 }, error: null },                           // reconciliation: max voucher
      { data: null, error: null, count: 5 },                                   // count posted
      { data: null, error: null, count: 0 },                                   // count revaluation
      { data: null, error: null, count: 0 },                                   // fx receivables
      { data: null, error: null, count: 0 },                                   // fx payables
    ]

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(true) // warning, not blocking
    expect(result.warnings.some((w: string) => w.includes('Sequence counter ahead'))).toBe(true)
    expect(result.sequenceMismatches).toHaveLength(1)
  })
})

describe('previewYearEndClosing', () => {
  it('calculates net result from class 3-8 accounts', async () => {
    results = [
      // 0: fetch company_settings (.single)
      { data: { entity_type: 'aktiebolag' }, error: null },
      // 1: fetch fiscal period for closing date (.single)
      { data: { period_end: '2024-12-31' }, error: null },
    ]

    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 150000,
    } as never)

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3001', account_name: 'Tjänsteintäkter', account_class: 3, closing_debit: 0, closing_credit: 500000 },
        { account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 200000, closing_credit: 0 },
        { account_number: '6570', account_name: 'Bankavgifter', account_class: 6, closing_debit: 150000, closing_credit: 0 },
      ],
      isBalanced: true,
      totalDebit: 350000,
      totalCredit: 500000,
    } as never)

    const supabase = makeClient()
    const preview = await previewYearEndClosing(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(preview.netResult).toBe(150000)
    expect(preview.closingAccount).toBe('2099')
    expect(preview.closingAccountName).toBe('Årets resultat')
    expect(preview.closingLines.length).toBeGreaterThanOrEqual(3)
    expect(preview.resultAccountSummary).toHaveLength(3)
  })

  it('uses 2010 for EF entity type', async () => {
    results = [
      { data: { entity_type: 'enskild_firma' }, error: null },
      // fetch fiscal period for closing date (.single)
      { data: { period_end: '2024-12-31' }, error: null },
    ]

    vi.mocked(generateIncomeStatement).mockResolvedValue({ net_result: 50000 } as never)
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3001', account_name: 'Intäkter', account_class: 3, closing_debit: 0, closing_credit: 100000 },
        { account_number: '5010', account_name: 'Kostnader', account_class: 5, closing_debit: 50000, closing_credit: 0 },
      ],
      isBalanced: true,
      totalDebit: 50000,
      totalCredit: 100000,
    } as never)

    const supabase = makeClient()
    const preview = await previewYearEndClosing(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(preview.closingAccount).toBe('2010')
    expect(preview.closingAccountName).toBe('Eget kapital')
  })
})
