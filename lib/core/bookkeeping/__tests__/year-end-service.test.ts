import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeFiscalPeriod } from '@/tests/helpers'

// ============================================================
// Mock: separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown; count?: number | null }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lte', 'gte', 'in', 'neq', 'not', 'or', 'order', 'limit', 'is', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

// ============================================================
// Filter-aware mock, used by the balansdagen FX readiness tests
// ============================================================

type Row = Record<string, unknown>

interface SeededTables {
  fiscal_periods?: Row[]
  journal_entries?: Row[]
  voucher_sequences?: Row[]
  invoices?: Row[]
  supplier_invoices?: Row[]
  invoice_payments?: Row[]
  supplier_invoice_payments?: Row[]
  company_settings?: Row[]
}

/**
 * Resolves each query by actually applying its filters to a seeded table,
 * unlike the positional queue above which hands back a fixed row set no matter
 * what was asked for.
 *
 * The FX readiness check is entirely a question about WHICH rows a query
 * selects: status at balansdagen vs status now, `entry_date` on the
 * revaluation verifikat, presence of `exchange_rate`. A queue mock answers all
 * of those identically and so cannot tell the old behaviour from the new one.
 */
function makeFilteringClient(tables: SeededTables, failTable?: string) {
  return {
    from: vi.fn((table: string) => {
      const eqs: Array<[string, unknown]> = []
      const neqs: Array<[string, unknown]> = []
      const ins: Array<[string, unknown[]]> = []
      const ltes: Array<[string, string]> = []
      const notNull: string[] = []
      let head = false
      let orderColumn: string | null = null
      let orderAscending = true
      let limitN: number | null = null
      let rangeFrom: number | null = null
      let rangeTo: number | null = null

      function matching(): Row[] {
        if (failTable === table) throw new Error(`simulated query failure on ${table}`)
        const out = (tables[table as keyof SeededTables] ?? []).filter(
          (r) =>
            eqs.every(([c, v]) => r[c] === v) &&
            neqs.every(([c, v]) => r[c] !== v) &&
            ins.every(([c, vs]) => vs.includes(r[c])) &&
            ltes.every(([c, v]) => String(r[c] ?? '') <= v) &&
            notNull.every((c) => r[c] != null)
        )
        if (orderColumn) {
          const col = orderColumn
          out.sort((a, b2) => {
            const av = a[col] as string | number
            const bv = b2[col] as string | number
            if (av === bv) return 0
            return (av < bv ? -1 : 1) * (orderAscending ? 1 : -1)
          })
        }
        return limitN == null ? out : out.slice(0, limitN)
      }

      function resolve() {
        const all = matching()
        const paged = rangeFrom == null ? all : all.slice(rangeFrom, (rangeTo ?? 0) + 1)
        return { data: head ? null : paged, error: null, count: all.length }
      }

      const b: Record<string, unknown> = {}
      b.select = vi.fn((_cols?: string, opts?: { head?: boolean }) => {
        head = opts?.head === true
        return b
      })
      b.eq = vi.fn((c: string, v: unknown) => { eqs.push([c, v]); return b })
      b.neq = vi.fn((c: string, v: unknown) => { neqs.push([c, v]); return b })
      b.in = vi.fn((c: string, v: unknown[]) => { ins.push([c, v]); return b })
      b.lte = vi.fn((c: string, v: string) => { ltes.push([c, v]); return b })
      b.not = vi.fn((c: string, op: string, v: unknown) => {
        if (op === 'is' && v === null) notNull.push(c)
        return b
      })
      b.order = vi.fn((c: string, opts?: { ascending?: boolean }) => {
        orderColumn = c
        orderAscending = opts?.ascending !== false
        return b
      })
      b.limit = vi.fn((n: number) => { limitN = n; return b })
      b.range = vi.fn((from: number, to: number) => { rangeFrom = from; rangeTo = to; return b })
      for (const m of ['gte', 'is', 'or', 'insert', 'update', 'delete']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.single = vi.fn(async () => ({ data: matching()[0] ?? null, error: null }))
      b.maybeSingle = vi.fn(async () => ({ data: matching()[0] ?? null, error: null }))
      b.then = (done: (v: unknown) => void) => done(resolve())
      return b
    }),
    rpc: vi.fn(async () => ({ data: [], error: null })),
  }
}

const FX_PERIOD_END = '2024-12-31'

/**
 * Baseline books that pass every non-FX readiness gate: one posted verifikat,
 * no drafts, no voucher gaps, sequence counter reconciled.
 */
function fxBaseTables(extra: SeededTables = {}): SeededTables {
  return {
    fiscal_periods: [
      makeFiscalPeriod({
        id: 'fp-1',
        company_id: 'company-1',
        is_closed: false,
        closing_entry_id: null,
        period_end: FX_PERIOD_END,
      }) as unknown as Row,
    ],
    voucher_sequences: [
      { company_id: 'company-1', fiscal_period_id: 'fp-1', voucher_series: 'A', last_number: 10 },
    ],
    journal_entries: [
      {
        company_id: 'company-1',
        fiscal_period_id: 'fp-1',
        voucher_series: 'A',
        voucher_number: 10,
        status: 'posted',
        source_type: 'manual',
        entry_date: '2024-06-01',
      },
      ...(extra.journal_entries ?? []),
    ],
    invoices: extra.invoices ?? [],
    supplier_invoices: extra.supplier_invoices ?? [],
    invoice_payments: extra.invoice_payments ?? [],
    supplier_invoice_payments: extra.supplier_invoice_payments ?? [],
  }
}

/** A posted currency_revaluation verifikat dated `entryDate`. */
function revaluationEntry(entryDate: string): Row {
  return {
    company_id: 'company-1',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    voucher_number: 5,
    status: 'posted',
    source_type: 'currency_revaluation',
    entry_date: entryDate,
  }
}

/** An open EUR customer invoice. `exchange_rate: null` = never converted. */
function fxInvoice(overrides: Row = {}): Row {
  return {
    id: `inv-${Math.random().toString(36).slice(2, 10)}`,
    company_id: 'company-1',
    status: 'sent',
    currency: 'EUR',
    exchange_rate: 11.2,
    invoice_date: '2024-11-15',
    total: 1000,
    paid_amount: 0,
    remaining_amount: 1000,
    paid_at: null,
    ...overrides,
  }
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
  reverseEntry: vi.fn(),
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
  // Default: clean books. Individual tests override to simulate unbooked
  // transactions or a failed check (fail-closed).
  countUnbookedInPeriod: vi.fn().mockResolvedValue({ untriaged: 0, businessUnbooked: 0 }),
  createNextPeriod: vi.fn(),
  findNextPeriod: vi.fn().mockResolvedValue(null),
}))

import { validateYearEndReadiness, previewYearEndClosing } from '../year-end-service'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { countUnbookedInPeriod, findNextPeriod } from '../period-service'
import {
  buildCutoffLines,
  KONTANTMETOD_CUTOFF_DESCRIPTIONS,
  reverseLines,
} from '../kontantmetod-cutoff'

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
    balansdagenRevalCount?: number
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
      { data: null, error: null, count: overrides.balansdagenRevalCount ?? 0 }, // revaluation dated on balansdagen (thenable)
      { data: null, error: null },                                            // open FX receivables: no rows (fetchAllRows)
      { data: null, error: null },                                            // open FX payables: no rows (fetchAllRows)
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
    expect(result.errors.some((e: string) => e.includes('utkast'))).toBe(true)
    expect(result.blockers.some((b) => b.code === 'DRAFT_ENTRIES')).toBe(true)
    // errors is the message mirror of blockers: same order, same strings.
    expect(result.errors).toEqual(result.blockers.map((b) => b.message))
  })

  it('returns a coded PERIOD_NOT_FOUND blocker when the period is missing', async () => {
    results = [{ data: null, error: { message: 'not found' } }]

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-x')
    expect(result.ready).toBe(false)
    expect(result.blockers).toEqual([
      { code: 'PERIOD_NOT_FOUND', message: 'Räkenskapsperioden hittades inte' },
    ])
    expect(result.errors).toEqual(['Räkenskapsperioden hittades inte'])
  })

  it('codes closed-period, existing closing entry, and continuity blockers', async () => {
    const period = {
      ...makeFiscalPeriod({ id: 'fp-1', is_closed: true, closing_entry_id: 'ce-1' }),
      continuity_verified: false,
    }
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
    const codes = result.blockers.map((b) => b.code)
    expect(codes).toContain('PERIOD_ALREADY_CLOSED')
    expect(codes).toContain('CLOSING_ENTRY_EXISTS')
    expect(codes).toContain('CONTINUITY_MISMATCH')
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
    expect(result.errors.some((e: string) => e.includes('Råbalansen balanserar inte'))).toBe(true)
    expect(result.blockers.some((b) => b.code === 'TRIAL_BALANCE_UNBALANCED')).toBe(true)
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
    expect(result.errors.some((e: string) => e.includes('slutdatumet har inte passerat'))).toBe(true)
    expect(result.blockers.some((b) => b.code === 'PERIOD_NOT_ENDED')).toBe(true)
  })

  it('blocks when the period contains unbooked bank transactions', async () => {
    // Previously only lockPeriod caught this, at step 7 of the execute flow,
    // AFTER the closing entry had posted: readiness said ready: true and the
    // run aborted mid-flow. The count must block up front.
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })
    results = noGapResults(period)

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 0,
      totalCredit: 0,
    } as never)
    vi.mocked(countUnbookedInPeriod).mockResolvedValueOnce({ untriaged: 2, businessUnbooked: 1 })

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(result.unbookedTransactionCount).toBe(3)
    expect(result.errors.some((e: string) => e.includes('3 transaktioner i perioden saknar bokföring'))).toBe(true)
    // The code is what the wizard and the MCP tool route on: losing it would
    // silently drop the remediation link and the 'unbooked_transactions' kind.
    expect(result.blockers.some((b) => b.code === 'UNBOOKED_TRANSACTIONS')).toBe(true)
    expect(result.errors).toEqual(result.blockers.map((b) => b.message))
  })

  it('fails closed when the unbooked-transaction check cannot run', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })
    results = noGapResults(period)

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 0,
      totalCredit: 0,
    } as never)
    vi.mocked(countUnbookedInPeriod).mockRejectedValueOnce(new Error('query failed'))

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(
      result.errors.some((e: string) =>
        e.includes('Kontrollen av obokförda transaktioner kunde inte genomföras'),
      ),
    ).toBe(true)
    expect(result.blockers.some((b) => b.code === 'UNBOOKED_CHECK_FAILED')).toBe(true)
    expect(result.errors).toEqual(result.blockers.map((b) => b.message))
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
    expect(result.warnings.some((w: string) => w.includes('dokumenterat'))).toBe(true)
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
      { data: [], error: null },                                               // gap_explanations: empty
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
    expect(result.errors.some((e: string) => e.includes('Oförklarat verifikationsnummerglapp'))).toBe(true)
    expect(result.blockers.some((b) => b.code === 'UNEXPLAINED_VOUCHER_GAP')).toBe(true)
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
      { data: [], error: null },                                                         // gap_explanations: empty
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
    expect(result.errors.some((e: string) => e.includes('serie A'))).toBe(true)
    expect(result.errors.some((e: string) => e.includes('serie B'))).toBe(true)
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
    expect(result.errors.some((e: string) => e.includes('Nummerserien i serie'))).toBe(true)
    expect(result.blockers.some((b) => b.code === 'SEQUENCE_COUNTER_BEHIND')).toBe(true)
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
    expect(result.warnings.some((w: string) => w.includes('Nummerräknaren ligger före'))).toBe(true)
    expect(result.sequenceMismatches).toHaveLength(1)
  })

  it('warns (not errors) when next period already exists without IB', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })
    results = noGapResults(period)

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)

    vi.mocked(findNextPeriod).mockResolvedValueOnce({
      id: 'fp-2',
      name: 'FY 2025',
      opening_balance_entry_id: null,
    } as never)

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(true)
    // Period name intentionally not interpolated into the warning: see
    // year-end-service for rationale. We assert on the stable English
    // substring instead.
    expect(result.warnings.some((w: string) => w.includes('Nästa räkenskapsperiod finns redan'))).toBe(true)
  })

  it('blocks when next period already has opening balances posted', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closing_entry_id: null })
    results = noGapResults(period)

    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)

    vi.mocked(findNextPeriod).mockResolvedValueOnce({
      id: 'fp-2',
      name: 'FY 2025',
      opening_balance_entry_id: 'ib-1',
    } as never)

    const supabase = makeClient()
    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.ready).toBe(false)
    expect(result.errors.some((e: string) => e.includes('redan ingående balanser bokförda'))).toBe(true)
    expect(result.blockers.some((b) => b.code === 'NEXT_PERIOD_HAS_IB')).toBe(true)
  })
})

describe('validateYearEndReadiness: kontantmetoden cut-off gate', () => {
  const nextPeriod = {
    id: 'fp-2', period_start: '2025-01-01', period_end: '2025-12-31',
    is_closed: false, locked_at: null, opening_balance_entry_id: null,
  }
  const openInvoice = {
    id: 'inv-1', company_id: 'company-1', invoice_number: 'F-1',
    invoice_date: '2024-12-15', status: 'sent', total: 1250, total_sek: 1250,
    vat_amount: 250, vat_amount_sek: 250, vat_treatment: 'standard_25',
    credited_invoice_id: null, document_type: 'invoice',
  }

  beforeEach(() => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [], isBalanced: true, totalDebit: 10000, totalCredit: 10000,
    } as never)
    vi.mocked(findNextPeriod).mockResolvedValue(nextPeriod as never)
  })

  function cashTables(journalEntries: Row[] = []): SeededTables {
    return {
      ...fxBaseTables({ journal_entries: journalEntries }),
      company_settings: [{
        company_id: 'company-1', accounting_method: 'cash', entity_type: 'aktiebolag',
      }],
      invoices: [openInvoice],
    }
  }

  it('blocks year-end when an outstanding invoice has no matching cut-off pair', async () => {
    const result = await validateYearEndReadiness(
      makeFilteringClient(cashTables()) as never,
      'company-1', 'user-1', 'fp-1',
    )

    expect(result.ready).toBe(false)
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'KONTANTMETOD_CUTOFF_REQUIRED',
    }))
  })

  it('clears only after the exact cut-off and next-period reversal are posted', async () => {
    const expected = buildCutoffLines([{
      id: 'inv-1', reference: 'F-1', vatTreatment: 'standard_25',
      outstanding: 1250, vat: 250,
    }], [])
    const markers = [
      {
        id: 'cutoff', company_id: 'company-1', fiscal_period_id: 'fp-1',
        voucher_series: 'A', voucher_number: 10, status: 'posted', source_type: 'year_end',
        source_id: 'fp-1', entry_date: '2024-12-31',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
        lines: expected.receivableLines,
      },
      {
        id: 'reversal', company_id: 'company-1', fiscal_period_id: 'fp-2',
        voucher_series: 'A', voucher_number: 1, status: 'posted', source_type: 'year_end',
        source_id: 'fp-1', entry_date: '2025-01-01',
        description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
        lines: reverseLines(expected.receivableLines),
      },
    ]

    const result = await validateYearEndReadiness(
      makeFilteringClient(cashTables(markers)) as never,
      'company-1', 'user-1', 'fp-1',
    )
    expect(result.blockers.some((blocker) =>
      blocker.code === 'KONTANTMETOD_CUTOFF_REQUIRED' ||
      blocker.code === 'KONTANTMETOD_CUTOFF_CHECK_FAILED',
    )).toBe(false)
    expect(result.ready).toBe(true)
  })

  it('fails closed when the cut-off query cannot run', async () => {
    const result = await validateYearEndReadiness(
      makeFilteringClient(cashTables(), 'company_settings') as never,
      'company-1', 'user-1', 'fp-1',
    )
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'KONTANTMETOD_CUTOFF_CHECK_FAILED',
    }))
  })
})

describe('validateYearEndReadiness: open FX items at balansdagen (ÅRL 4 kap. 13 §)', () => {
  beforeEach(() => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [],
      isBalanced: true,
      totalDebit: 10000,
      totalCredit: 10000,
    } as never)
    vi.mocked(findNextPeriod).mockResolvedValue(null as never)
  })

  const revaluationWarning = (w: string) => w.includes('har inte omvärderats till balansdagskurs')
  const missingRateWarning = (w: string) => w.includes('saknar valutakurs')

  it('does not let one interim revaluation hide items still open on balansdagen', async () => {
    // A single revaluation run in June. Twelve invoices were still outstanding
    // on 31 December and none of them were valued at the balansdagen rate.
    const supabase = makeFilteringClient(
      fxBaseTables({
        journal_entries: [revaluationEntry('2024-06-30')],
        invoices: Array.from({ length: 12 }, (_, i) => fxInvoice({ id: `inv-${i}` })),
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.warnings.filter(revaluationWarning)).toHaveLength(1)
    expect(result.warnings.find(revaluationWarning)).toContain('12 post(er)')
    expect(result.warnings.find(revaluationWarning)).toContain(FX_PERIOD_END)
    // Advisory, not a blocker: executeYearEndClosing revalues in its step 2.
    expect(result.ready).toBe(true)
  })

  it('counts items with no exchange rate at all and states the different remedy', async () => {
    const supabase = makeFilteringClient(
      fxBaseTables({
        invoices: [
          fxInvoice({ id: 'inv-a', exchange_rate: null }),
          fxInvoice({ id: 'inv-b', exchange_rate: null }),
          fxInvoice({ id: 'inv-c', exchange_rate: 0 }),
        ],
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    // These are invisible to the revaluation, so they get their own warning
    // with its own remedy, and they are never folded into the other count.
    const missing = result.warnings.find(missingRateWarning)
    expect(missing).toBeDefined()
    expect(missing).toContain('3 post(er)')
    expect(missing).toContain('Registrera kursen på fakturan')
    expect(result.warnings.filter(revaluationWarning)).toHaveLength(0)
    expect(result.ready).toBe(true)
  })

  it('separates the two states when both are present', async () => {
    const supabase = makeFilteringClient(
      fxBaseTables({
        invoices: [
          fxInvoice({ id: 'inv-rate-1' }),
          fxInvoice({ id: 'inv-rate-2' }),
          fxInvoice({ id: 'inv-norate', exchange_rate: null }),
        ],
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.warnings.find(missingRateWarning)).toContain('1 post(er)')
    expect(result.warnings.find(revaluationWarning)).toContain('2 post(er)')
  })

  it('still reports a clean company as ready with no FX warning', async () => {
    const supabase = makeFilteringClient(fxBaseTables())

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.ready).toBe(true)
    expect(result.warnings.filter((w: string) => w.includes('valuta'))).toHaveLength(0)
  })

  it('counts an invoice paid after balansdagen: it was open on the balance sheet date', async () => {
    // Status today is 'paid', status on 31 December was open. ÅRL 4 kap. 13 §
    // values the item at balansdagen, so it must still be counted.
    const supabase = makeFilteringClient(
      fxBaseTables({
        invoices: [
          fxInvoice({
            id: 'inv-late-paid',
            status: 'paid',
            invoice_date: '2024-10-01',
            total: 5000,
            paid_amount: 5000,
            remaining_amount: 0,
            paid_at: '2025-03-10',
          }),
        ],
        invoice_payments: [
          {
            id: 'pay-1',
            company_id: 'company-1',
            invoice_id: 'inv-late-paid',
            amount: 5000,
            payment_date: '2025-03-10',
          },
        ],
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.warnings.find(revaluationWarning)).toContain('1 post(er)')
  })

  it('counts a partially paid FX invoice: its unpaid remainder was open on balansdagen', async () => {
    // payment-sync sets 'partially_paid' on partial settlements. The old
    // status list ('sent'/'overdue'/'paid') never matched it, so the readiness
    // check reported no exposure for a receivable whose 600 EUR remainder
    // still had to be valued at balansdagskurs (ÅRL 4 kap. 13 §).
    const supabase = makeFilteringClient(
      fxBaseTables({
        invoices: [
          fxInvoice({
            id: 'inv-partial',
            status: 'partially_paid',
            total: 1000,
            paid_amount: 400,
            remaining_amount: 600,
          }),
        ],
        invoice_payments: [
          {
            id: 'pay-partial',
            company_id: 'company-1',
            invoice_id: 'inv-partial',
            amount: 400,
            payment_date: '2024-12-01',
          },
        ],
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.warnings.find(revaluationWarning)).toContain('1 post(er)')
  })

  it('ignores an invoice issued after balansdagen even though it is open today', async () => {
    // The mirror image: open now, did not exist on the balance sheet date.
    const supabase = makeFilteringClient(
      fxBaseTables({
        invoices: [fxInvoice({ id: 'inv-next-year', invoice_date: '2025-02-01' })],
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.warnings.filter((w: string) => w.includes('valuta'))).toHaveLength(0)
  })

  it('counts open FX payables as well as receivables', async () => {
    const supabase = makeFilteringClient(
      fxBaseTables({
        supplier_invoices: [
          {
            id: 'si-1',
            company_id: 'company-1',
            status: 'approved',
            currency: 'USD',
            exchange_rate: 10.4,
            invoice_date: '2024-09-01',
            total: 2000,
            paid_amount: 0,
            remaining_amount: 2000,
            paid_at: null,
          },
          {
            id: 'si-2',
            company_id: 'company-1',
            status: 'registered',
            currency: 'USD',
            exchange_rate: null,
            invoice_date: '2024-09-02',
            total: 800,
            paid_amount: 0,
            remaining_amount: 800,
            paid_at: null,
          },
        ],
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.warnings.find(revaluationWarning)).toContain('1 post(er)')
    expect(result.warnings.find(missingRateWarning)).toContain('1 post(er)')
  })

  it('suppresses only the revaluation warning when a balansdagen revaluation exists', async () => {
    const supabase = makeFilteringClient(
      fxBaseTables({
        journal_entries: [revaluationEntry(FX_PERIOD_END)],
        invoices: [
          fxInvoice({ id: 'inv-rate-1' }),
          fxInvoice({ id: 'inv-rate-2' }),
          fxInvoice({ id: 'inv-norate', exchange_rate: null }),
        ],
      })
    )

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.warnings.filter(revaluationWarning)).toHaveLength(0)
    // The posted revaluation provably did not include the unconverted row:
    // previewCurrencyRevaluation partitions it out. So it stays warned about.
    expect(result.warnings.find(missingRateWarning)).toContain('1 post(er)')
  })

  it('says the check did not run rather than reporting no exposure when it fails', async () => {
    const supabase = makeFilteringClient(fxBaseTables(), 'invoices')

    const result = await validateYearEndReadiness(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(
      result.warnings.some((w: string) => w.includes('kunde inte genomföras'))
    ).toBe(true)
    expect(result.ready).toBe(true)
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

    // Deliberately different from the trial-balance-derived result: netResult
    // must NOT come from the income statement anymore (issue #766).
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 999,
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
    expect(generateIncomeStatement).not.toHaveBeenCalled()
    expect(preview.closingAccount).toBe('2099')
    expect(preview.closingAccountName).toBe('Årets resultat')
    expect(preview.closingLines.length).toBeGreaterThanOrEqual(3)
    expect(preview.resultAccountSummary).toHaveLength(3)

    // Profit: the 2099 line is a credit equal to netResult.
    const closingLine2099 = preview.closingLines.find((l) => l.account_number === '2099')
    expect(closingLine2099).toBeDefined()
    expect(closingLine2099?.debit_amount).toBe(0)
    expect(closingLine2099?.credit_amount).toBe(preview.netResult)
  })

  it('includes year_end-tagged depreciation in netResult and matches the 2099 line (issue #766)', async () => {
    results = [
      // 0: fetch company_settings (.single)
      { data: { entity_type: 'aktiebolag' }, error: null },
      // 1: fetch fiscal period for closing date (.single)
      { data: { period_end: '2024-12-31' }, error: null },
    ]

    // Old behavior took netResult from the income statement, which excludes
    // source_type='year_end' entries: it would have reported the
    // pre-depreciation loss of 10 000. The mock returns that stale value to
    // prove the service no longer uses it.
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: -10000,
    } as never)

    // Trial balance WITHOUT excludeYearEndClosing sees the bokslut-flow
    // depreciation verifikat (78xx, source_type='year_end').
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3001', account_name: 'Tjänsteintäkter', account_class: 3, closing_debit: 0, closing_credit: 90000 },
        { account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 100000, closing_credit: 0 },
        { account_number: '7832', account_name: 'Avskrivningar inventarier', account_class: 7, closing_debit: 2000, closing_credit: 0 },
      ],
      isBalanced: true,
      totalDebit: 102000,
      totalCredit: 90000,
    } as never)

    const supabase = makeClient()
    const preview = await previewYearEndClosing(supabase as never, 'company-1', 'user-1', 'fp-1')

    // Loss including depreciation: 90 000 - 100 000 - 2 000 = -12 000,
    // not the pre-depreciation -10 000.
    expect(preview.netResult).toBe(-12000)

    // The summary figure equals the signed amount on the 2099 balancing line:
    // a loss is a debit to 2099.
    const closingLine2099 = preview.closingLines.find((l) => l.account_number === '2099')
    expect(closingLine2099).toBeDefined()
    expect(closingLine2099?.debit_amount).toBe(12000)
    expect(closingLine2099?.credit_amount).toBe(0)
    expect(preview.netResult).toBe(-(closingLine2099?.debit_amount ?? NaN))
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

  it('flags bolagsskattMissing for AB profit year without any 89xx tax account', async () => {
    results = [
      { data: { entity_type: 'aktiebolag' }, error: null },
      { data: { period_end: '2024-12-31' }, error: null },
    ]
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3001', account_name: 'Tjänsteintäkter', account_class: 3, closing_debit: 0, closing_credit: 500000 },
        { account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 200000, closing_credit: 0 },
        { account_number: '8811', account_name: 'Avsättning till periodiseringsfond', account_class: 8, closing_debit: 75000, closing_credit: 0 },
      ],
      isBalanced: true,
      totalDebit: 275000,
      totalCredit: 500000,
    } as never)

    const supabase = makeClient()
    const preview = await previewYearEndClosing(supabase as never, 'company-1', 'user-1', 'fp-1')

    // 8811 is a disposition, not a tax account: the warning must still fire.
    expect(preview.netResult).toBe(225000)
    expect(preview.bolagsskattMissing).toBe(true)
  })

  it('does not flag bolagsskattMissing when 8910 is booked', async () => {
    results = [
      { data: { entity_type: 'aktiebolag' }, error: null },
      { data: { period_end: '2024-12-31' }, error: null },
    ]
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3001', account_name: 'Tjänsteintäkter', account_class: 3, closing_debit: 0, closing_credit: 500000 },
        { account_number: '8910', account_name: 'Skatt på årets resultat', account_class: 8, closing_debit: 103000, closing_credit: 0 },
      ],
      isBalanced: true,
      totalDebit: 103000,
      totalCredit: 500000,
    } as never)

    const supabase = makeClient()
    const preview = await previewYearEndClosing(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(preview.bolagsskattMissing).toBe(false)
  })

  it('does not flag bolagsskattMissing for a loss year or for EF', async () => {
    // Loss year, AB
    results = [
      { data: { entity_type: 'aktiebolag' }, error: null },
      { data: { period_end: '2024-12-31' }, error: null },
    ]
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3001', account_name: 'Tjänsteintäkter', account_class: 3, closing_debit: 0, closing_credit: 100000 },
        { account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 150000, closing_credit: 0 },
      ],
      isBalanced: true,
      totalDebit: 150000,
      totalCredit: 100000,
    } as never)

    const supabase = makeClient()
    const lossPreview = await previewYearEndClosing(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(lossPreview.netResult).toBe(-50000)
    expect(lossPreview.bolagsskattMissing).toBe(false)

    // Profit year, EF (tax is never booked for enskild firma)
    resultIdx = 0
    results = [
      { data: { entity_type: 'enskild_firma' }, error: null },
      { data: { period_end: '2024-12-31' }, error: null },
    ]
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3001', account_name: 'Intäkter', account_class: 3, closing_debit: 0, closing_credit: 100000 },
      ],
      isBalanced: true,
      totalDebit: 0,
      totalCredit: 100000,
    } as never)

    const efPreview = await previewYearEndClosing(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(efPreview.netResult).toBe(100000)
    expect(efPreview.bolagsskattMissing).toBe(false)
  })
})
