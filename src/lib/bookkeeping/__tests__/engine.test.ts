import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateBalance,
  createDraftEntry,
  createJournalEntry,
  replaceOpeningBalanceEntry,
  reverseEntry,
  assertLinesWellFormed,
  cancelOrphanedEntry,
  commitStornoOrCorrectionDraft,
} from '../engine'
import { runWithActor } from '../actor-context-node'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotReverseStornoError,
  CannotReverseCollectedPaymentError,
  EntryDateOutsideFiscalPeriodError,
  JournalLineBothSidesNonZeroError,
  JournalLineNegativeAmountError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
  getUnusedVoucherAllocation,
} from '../errors'
import type { CreateJournalEntryLineInput, JournalEntryStatus } from '@/types'

// Mock Supabase client for createDraftEntry/reverseEntry tests
function createMockChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: overrides.singleData ?? null, error: overrides.singleError ?? null }),
    eq: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  }
  return chain
}

// The storno target check (date inside the original's year, year open) has
// its own tests (lib/core/bookkeeping/__tests__/storno-target.test.ts) and is
// a pass-through here; the reverseEntry tests below that refuse override it.
const mockAssertStornoTarget = vi.fn(
  async (_supabase: unknown, _companyId: string, original: { entry_date: string; fiscal_period_id: string }, date?: string) =>
    ({ date: date ?? original.entry_date, fiscal_period_id: original.fiscal_period_id, moved: false }),
)
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({
  assertStornoTarget: (...args: Parameters<typeof mockAssertStornoTarget>) => mockAssertStornoTarget(...args),
}))

// Mock event bus
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

// The payout mirror after a reversed collections payout voucher.
const mockReleaseSettlement = vi.fn().mockResolvedValue({ released: true })
vi.mock('@/lib/collections/settlement-reversal', () => ({
  releaseSettlementAfterReversal: (...args: unknown[]) => mockReleaseSettlement(...args),
}))

// The kundförlust decision mirror around a storno of a customer_loss voucher.
const mockAssertCustomerLossReversible = vi.fn().mockResolvedValue(undefined)
const mockSyncCustomerLoss = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/customer-loss/reversal', () => ({
  assertCustomerLossReversible: (...args: unknown[]) => mockAssertCustomerLossReversible(...args),
  syncCustomerLossAfterReversal: (...args: unknown[]) => mockSyncCustomerLoss(...args),
}))

// Mock the on-demand BAS backfill, default: nothing seedable. Individual
// tests override per scenario.
const mockBackfill = vi.fn().mockResolvedValue([])
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => mockBackfill(...args),
}))

describe('validateBalance', () => {
  it('balanced entry (debit == credit) → valid: true', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(true)
    expect(result.totalDebit).toBe(1000)
    expect(result.totalCredit).toBe(1000)
  })

  it('unbalanced entry → valid: false', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 500 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
    expect(result.totalDebit).toBe(1000)
    expect(result.totalCredit).toBe(500)
  })

  it('zero amounts → valid: false (roundedDebit must be > 0)', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 0, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 0 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
    expect(result.totalDebit).toBe(0)
    expect(result.totalCredit).toBe(0)
  })

  it('floating point edge case (33.33 + 33.33 + 33.34) → valid: true', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 33.33, credit_amount: 0 },
      { account_number: '1930', debit_amount: 33.33, credit_amount: 0 },
      { account_number: '1930', debit_amount: 33.34, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 100 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(true)
    expect(result.totalDebit).toBe(100)
    expect(result.totalCredit).toBe(100)
  })

  it('single line (only debit, no credit) → valid: false', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 500, credit_amount: 0 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
  })
})

describe('assertLinesWellFormed', () => {
  it('accepts one non-negative side per line', () => {
    expect(() =>
      assertLinesWellFormed([
        { account_number: '6110', debit_amount: 16000, credit_amount: 0 },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
        { account_number: '2440', debit_amount: 0, credit_amount: 15999.75 },
      ])
    ).not.toThrow()
  })

  it('rejects a negative debit even though the entry balances arithmetically', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '6110', debit_amount: 16000, credit_amount: 0 },
      { account_number: '3740', debit_amount: -0.25, credit_amount: 0 },
      { account_number: '2440', debit_amount: 0, credit_amount: 15999.75 },
    ]
    expect(validateBalance(lines).valid).toBe(true)
    expect(() => assertLinesWellFormed(lines)).toThrow(JournalLineNegativeAmountError)
    try {
      assertLinesWellFormed(lines)
    } catch (err) {
      const e = err as JournalLineNegativeAmountError
      expect(e.code).toBe('JOURNAL_LINE_NEGATIVE_AMOUNT')
      expect(e.accountNumber).toBe('3740')
      expect(e.debitAmount).toBe(-0.25)
    }
  })

  it('rejects a negative credit', () => {
    expect(() =>
      assertLinesWellFormed([
        { account_number: '1510', debit_amount: 999.5, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { account_number: '3740', debit_amount: 0, credit_amount: -0.5 },
      ])
    ).toThrow(JournalLineNegativeAmountError)
  })

  // Issue #2551: the totals-only balance math cannot see a self-cancelling
  // line, so this one has to.
  it('rejects a line carrying both sides even though the entry balances', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 100, credit_amount: 100 },
      { account_number: '1930', debit_amount: 50, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 50 },
    ]
    expect(validateBalance(lines).valid).toBe(true)
    expect(() => assertLinesWellFormed(lines)).toThrow(JournalLineBothSidesNonZeroError)
    try {
      assertLinesWellFormed(lines)
    } catch (err) {
      const e = err as JournalLineBothSidesNonZeroError
      expect(e.code).toBe('JOURNAL_LINE_BOTH_SIDES_NONZERO')
      expect(e.accountNumber).toBe('1930')
      expect(e.debitAmount).toBe(100)
      expect(e.creditAmount).toBe(100)
    }
  })

  it('rejects both sides even when they do not cancel', () => {
    expect(() =>
      assertLinesWellFormed([
        { account_number: '1930', debit_amount: 100, credit_amount: 40 },
        { account_number: '3001', debit_amount: 0, credit_amount: 60 },
      ])
    ).toThrow(JournalLineBothSidesNonZeroError)
  })

  it('reports the negative side first when a line is both negative and two-sided', () => {
    expect(() =>
      assertLinesWellFormed([
        { account_number: '1930', debit_amount: -100, credit_amount: 100 },
        { account_number: '3001', debit_amount: 0, credit_amount: 100 },
      ])
    ).toThrow(JournalLineNegativeAmountError)
  })

  it('accepts a zero line: the balance check owns the empty entry', () => {
    expect(() =>
      assertLinesWellFormed([
        { account_number: '1930', debit_amount: 0, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 0 },
      ])
    ).not.toThrow()
  })
})

describe('createDraftEntry: refuses malformed lines before any write', () => {
  it('throws JournalLineNegativeAmountError and never touches the database', async () => {
    const from = vi.fn()
    await expect(
      createDraftEntry({ from } as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2024-01-01',
        description: 'Leverantörsfaktura 374',
        source_type: 'supplier_invoice_registered',
        lines: [
          { account_number: '6110', debit_amount: 16000, credit_amount: 0 },
          { account_number: '3740', debit_amount: -0.25, credit_amount: 0 },
          { account_number: '2440', debit_amount: 0, credit_amount: 15999.75 },
        ],
      })
    ).rejects.toThrow(JournalLineNegativeAmountError)
    expect(from).not.toHaveBeenCalled()
  })

  it('throws JournalLineBothSidesNonZeroError and never touches the database (#2551)', async () => {
    const from = vi.fn()
    await expect(
      createDraftEntry({ from } as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-01-01',
        description: 'Nollverifikat',
        source_type: 'manual',
        lines: [
          { account_number: '1930', debit_amount: 100, credit_amount: 100 },
          { account_number: '3001', debit_amount: 0, credit_amount: 0 },
        ],
      })
    ).rejects.toThrow(JournalLineBothSidesNonZeroError)
    expect(from).not.toHaveBeenCalled()
  })
})

describe('createJournalEntry: refuses a both-sides line before any write (#2551)', () => {
  it('throws before the atomic draft+commit ever reaches the database', async () => {
    const from = vi.fn()
    const rpc = vi.fn()
    await expect(
      createJournalEntry({ from, rpc } as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-01-01',
        description: 'Nollverifikat',
        source_type: 'manual',
        lines: [
          { account_number: '1930', debit_amount: 100, credit_amount: 100 },
          { account_number: '1930', debit_amount: 50, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 50 },
        ],
      })
    ).rejects.toThrow(JournalLineBothSidesNonZeroError)
    expect(from).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('replaceOpeningBalanceEntry: refuses a both-sides line before any write (#2551)', () => {
  it('throws before the replacement touches the database', async () => {
    const from = vi.fn()
    const rpc = vi.fn()
    await expect(
      replaceOpeningBalanceEntry({ from, rpc } as never, 'company-1', 'user-1', 'entry-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-01-01',
        description: 'Ingående balanser',
        source_type: 'opening_balance',
        lines: [
          { account_number: '1930', debit_amount: 100, credit_amount: 100 },
          { account_number: '1930', debit_amount: 50, credit_amount: 0 },
          { account_number: '2081', debit_amount: 0, credit_amount: 50 },
        ],
      })
    ).rejects.toThrow(JournalLineBothSidesNonZeroError)
    expect(from).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('reverseEntry: legacy negative-side lines reverse on their net', () => {
  it('a debit -0.25 original becomes debit 0.25 on the storno, never credit -0.25', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 42,
      entry_date: '2026-06-06',
      description: 'Leverantörsfaktura 374',
      source_type: 'supplier_invoice_registered',
      source_id: null,
      lines: [
        { account_number: '6110', debit_amount: 16000, credit_amount: 0 },
        { account_number: '3740', debit_amount: -0.25, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 15999.75 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) b[m] = vi.fn().mockReturnValue(b)
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    let insertedLines: Array<{ account_number: string; debit_amount: number; credit_amount: number }> = []
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 43, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-6110', account_number: '6110' },
                { id: 'acc-3740', account_number: '3740' },
                { id: 'acc-2440', account_number: '2440' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockImplementation(async (rows: typeof insertedLines) => {
              insertedLines = rows
              return { error: null }
            }),
          }
        }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    const byAccount = Object.fromEntries(insertedLines.map((l) => [l.account_number, l]))
    expect(byAccount['6110']).toMatchObject({ debit_amount: 0, credit_amount: 16000 })
    expect(byAccount['3740']).toMatchObject({ debit_amount: 0.25, credit_amount: 0 })
    expect(byAccount['2440']).toMatchObject({ debit_amount: 15999.75, credit_amount: 0 })
    for (const l of insertedLines) {
      expect(l.debit_amount).toBeGreaterThanOrEqual(0)
      expect(l.credit_amount).toBeGreaterThanOrEqual(0)
    }
  })
})

// #3517: a revaluation leg on a foreign cash account is `USD, 0`. The engine
// stored it as null (a falsy check), which made the line unconvertible and
// every reconciliation of the account in USD gl_lines_missing_currency_amount.
describe('createDraftEntry: amount_in_currency 0 on a foreign line is kept (#3517)', () => {
  function captureLines() {
    let inserted: Array<Record<string, unknown>> = []
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq']) b[m] = vi.fn().mockReturnValue(b)
          b.single = vi.fn().mockResolvedValue({
            data: { name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
            error: null,
          })
          return b
        }
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: ['1930', '1932', '3960', '7960'].map((n) => ({ account_number: n, id: `acc-${n}` })),
              error: null,
            })
          return b
        }
        if (table === 'journal_entries') {
          const b: Record<string, unknown> = {}
          for (const m of ['insert', 'select', 'eq']) b[m] = vi.fn().mockReturnValue(b)
          b.single = vi.fn().mockResolvedValue({ data: { id: 'entry-1', status: 'draft', lines: [] }, error: null })
          return b
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockImplementation(async (rows: Array<Record<string, unknown>>) => {
              inserted = rows
              return { error: null }
            }),
          }
        }
        return createMockChain()
      }),
    }
    return { supabase, lines: () => inserted }
  }

  async function draft(lines: CreateJournalEntryLineInput[]) {
    const { supabase, lines: inserted } = captureLines()
    await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2026-03-31',
      description: 'Omvärdering USD-konto',
      source_type: 'manual',
      lines,
    })
    return Object.fromEntries(inserted().map((l) => [l.account_number, l]))
  }

  it('stores 0, not null, on a foreign-currency line', async () => {
    const byAccount = await draft([
      { account_number: '1932', debit_amount: 812.4, credit_amount: 0, currency: 'USD', amount_in_currency: 0 },
      { account_number: '3960', debit_amount: 0, credit_amount: 812.4 },
    ])
    expect(byAccount['1932']).toMatchObject({ currency: 'USD', amount_in_currency: 0 })
    expect(Object.is(byAccount['1932'].amount_in_currency, 0)).toBe(true)
    expect(byAccount['3960']).toMatchObject({ currency: 'SEK', amount_in_currency: null })
  })

  it('still stores null for 0 on a SEK or unlabelled line', async () => {
    const byAccount = await draft([
      { account_number: '1930', debit_amount: 100, credit_amount: 0, currency: 'SEK', amount_in_currency: 0 },
      { account_number: '7960', debit_amount: 0, credit_amount: 100, amount_in_currency: 0 },
    ])
    expect(byAccount['1930']).toMatchObject({ currency: 'SEK', amount_in_currency: null })
    expect(byAccount['7960']).toMatchObject({ currency: 'SEK', amount_in_currency: null })
  })

  it('rounds a non-zero foreign amount to öre exactly as before', async () => {
    const byAccount = await draft([
      { account_number: '1932', debit_amount: 1150, credit_amount: 0, currency: 'USD', amount_in_currency: 99.999 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1150 },
    ])
    expect(byAccount['1932']).toMatchObject({ currency: 'USD', amount_in_currency: 100 })
    expect(byAccount['1930']).toMatchObject({ amount_in_currency: null })
  })

  it('stores each line as the balance check read it: a half öre up', async () => {
    const byAccount = await draft([
      { account_number: '1932', debit_amount: 1.005, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1.01 },
    ])
    expect(byAccount['1932']).toMatchObject({ debit_amount: 1.01, credit_amount: 0 })
    expect(byAccount['1930']).toMatchObject({ debit_amount: 0, credit_amount: 1.01 })
  })
})

describe('createDraftEntry: a foreign bank row stamps its figure on its bank line (crm#1590)', () => {
  function captureLines() {
    let inserted: Array<Record<string, unknown>> = []
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq']) b[m] = vi.fn().mockReturnValue(b)
          b.single = vi.fn().mockResolvedValue({
            data: { name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
            error: null,
          })
          return b
        }
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: ['1930', '1940', '1510', '7960'].map((n) => ({ account_number: n, id: `acc-${n}` })),
              error: null,
            })
          return b
        }
        if (table === 'journal_entries') {
          const b: Record<string, unknown> = {}
          for (const m of ['insert', 'select', 'eq']) b[m] = vi.fn().mockReturnValue(b)
          b.single = vi.fn().mockResolvedValue({ data: { id: 'entry-1', status: 'draft', lines: [] }, error: null })
          return b
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockImplementation(async (rows: Array<Record<string, unknown>>) => {
              inserted = rows
              return { error: null }
            }),
          }
        }
        return createMockChain()
      }),
    }
    return { supabase, lines: () => inserted }
  }

  async function draft(currency: string, settlementAccount: string, lines: CreateJournalEntryLineInput[]) {
    const { supabase, lines: inserted } = captureLines()
    await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2026-10-20',
      description: 'Inbetalning kundfaktura 1001',
      source_type: 'invoice_paid',
      source_id: 'inv-1',
      bank_booking_context: [{
        transaction_id: 'tx-1', cash_account_id: 'cash-1', settlement_account: settlementAccount,
        date: '2026-10-20', amount: currency === 'SEK' ? 24470.6 : 2200, currency,
      }],
      lines,
    })
    return Object.fromEntries(inserted().map((l) => [l.account_number, l]))
  }

  const matchLines = (bank: string): CreateJournalEntryLineInput[] => [
    { account_number: bank, debit_amount: 24470.6, credit_amount: 0 },
    { account_number: '1510', debit_amount: 0, credit_amount: 24588.3, currency: 'EUR', amount_in_currency: 2200 },
    { account_number: '7960', debit_amount: 117.7, credit_amount: 0 },
  ]

  it('stores the EUR row on the 1940 line, kronor unchanged', async () => {
    const byAccount = await draft('EUR', '1940', matchLines('1940'))
    expect(byAccount['1940']).toMatchObject({ debit_amount: 24470.6, currency: 'EUR', amount_in_currency: 2200 })
    expect(byAccount['1510']).toMatchObject({ credit_amount: 24588.3, currency: 'EUR', amount_in_currency: 2200 })
    expect(byAccount['7960']).toMatchObject({ debit_amount: 117.7, currency: 'SEK', amount_in_currency: null })
  })

  it('leaves a SEK row exactly as before', async () => {
    const byAccount = await draft('SEK', '1930', [
      { account_number: '1930', debit_amount: 24470.6, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 24470.6 },
    ])
    expect(byAccount['1930']).toMatchObject({ currency: 'SEK', amount_in_currency: null })
    expect(byAccount['1510']).toMatchObject({ currency: 'SEK', amount_in_currency: null })
  })
})

describe('reverseEntry: a kept 0 in amount_in_currency reverses to 0 (#3517)', () => {
  it('the storno of a USD 0 line carries USD 0, not null', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 42,
      entry_date: '2026-03-31',
      description: 'Omvärdering USD-konto',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '1932', debit_amount: 812.4, credit_amount: 0, currency: 'USD', amount_in_currency: 0 },
        { account_number: '3960', debit_amount: 0, credit_amount: 812.4, currency: 'SEK', amount_in_currency: null },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }
    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) b[m] = vi.fn().mockReturnValue(b)
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }
    let insertedLines: Array<Record<string, unknown>> = []
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 43, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-1932', account_number: '1932' },
                { id: 'acc-3960', account_number: '3960' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockImplementation(async (rows: Array<Record<string, unknown>>) => {
              insertedLines = rows
              return { error: null }
            }),
          }
        }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    const byAccount = Object.fromEntries(insertedLines.map((l) => [l.account_number, l]))
    expect(byAccount['1932']).toMatchObject({ debit_amount: 0, credit_amount: 812.4, currency: 'USD', amount_in_currency: 0 })
    expect(Object.is(byAccount['1932'].amount_in_currency, 0)).toBe(true)
    expect(byAccount['3960']).toMatchObject({ debit_amount: 812.4, credit_amount: 0, amount_in_currency: null })
  })
})

describe('createDraftEntry: cancelled status on line-insert failure', () => {
  it('sets status to cancelled (not delete) when line insert fails', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2024', period_start: '2024-01-01', period_end: '2024-12-31' },
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
                  data: { id: 'entry-1', user_id: 'user-1', status: 'draft' as JournalEntryStatus },
                  error: null,
                }),
              }),
            }),
            update: updateMock,
            delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: { message: 'Line insert failed' } }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [{ account_number: '1930', id: 'acc-1' }, { account_number: '3001', id: 'acc-2' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        return createMockChain()
      }),
    }

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2024-01-01',
        description: 'Test',
        source_type: 'manual',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        ],
      })
    ).rejects.toThrow(BookkeepingDatabaseError)

    // Should call update with cancelled status, NOT delete
    expect(updateMock).toHaveBeenCalledWith({ status: 'cancelled' })
  })
})

describe('createDraftEntry: date/period cross-validation', () => {
  function buildSupabase(periodData: { name: string; period_start: string; period_end: string } | null) {
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: periodData,
                    error: periodData ? null : { message: 'Not found' },
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
                    data: [{ account_number: '1930', id: 'acc-1' }, { account_number: '3001', id: 'acc-2' }],
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
                  data: { id: 'entry-1', status: 'draft' },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft', lines: [] },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        return createMockChain()
      }),
    }
  }

  const validLines = [
    { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
  ]

  it('persists the caller bank snapshot on the draft header before creating its lines', async () => {
    const supabase = buildSupabase({ name: 'FY 2024', period_start: '2024-01-01', period_end: '2024-12-31' })
    const bankContext = [{ transaction_id: 'tx-1', cash_account_id: null, settlement_account: '1930',
      date: '2024-06-01', amount: 1000, currency: 'SEK' }]
    await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1', entry_date: '2024-06-01', description: 'Bank source',
      source_type: 'bank_transaction', source_id: 'tx-1', bank_booking_context: bankContext, lines: validLines,
    })
    const index = supabase.from.mock.calls.findIndex(([table]) => table === 'journal_entries')
    expect(supabase.from.mock.results[index].value.insert).toHaveBeenCalledWith(expect.objectContaining({
      bank_booking_context: bankContext,
    }))
  })

  it('rejects entry date before period start', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2024-12-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Entry date 2024-12-15 is outside fiscal period "FY 2025"')
  })

  it('rejects entry date after period end', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-01-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Entry date 2026-01-15 is outside fiscal period "FY 2025"')
  })

  it('accepts entry date within period', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-06-15',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
    expect(result.id).toBe('entry-1')
  })

  it('accepts entry date on period start boundary', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-01-01',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
  })

  it('accepts entry date on period end boundary', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-12-31',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
  })

  it('throws when fiscal period not found', async () => {
    const supabase = buildSupabase(null)

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'nonexistent',
        entry_date: '2025-06-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Fiscal period not found')
  })
})

describe('JournalEntryStatus type includes cancelled', () => {
  it('cancelled is a valid JournalEntryStatus value', () => {
    const status: JournalEntryStatus = 'cancelled'
    expect(['draft', 'posted', 'reversed', 'cancelled']).toContain(status)
  })
})

describe('createDraftEntry: on-demand BAS account backfill', () => {
  // Engine seeds standard BAS accounts missing from the chart instead of
  // failing (June 2026 incident: 3740 öresavrundning missing → payment
  // voucher dead end). Non-seedable numbers still throw.

  beforeEach(() => {
    mockBackfill.mockClear()
  })

  function buildSupabase(opts: { chartByCall: { account_number: string; id: string }[][] }) {
    let chartCall = 0
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          const result = opts.chartByCall[Math.min(chartCall++, opts.chartByCall.length - 1)]
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({ data: result, error: null }),
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
                  data: { id: 'entry-1', status: 'draft' },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft', lines: [] },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        return createMockChain()
      }),
    }
  }

  const LINES: CreateJournalEntryLineInput[] = [
    { account_number: '2440', debit_amount: 11231.25, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 11231 },
    { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
  ]

  it('seeds a missing standard BAS account and proceeds', async () => {
    mockBackfill.mockResolvedValue(['3740'])
    const supabase = buildSupabase({
      chartByCall: [
        // First resolution: 3740 missing
        [{ account_number: '2440', id: 'acc-1' }, { account_number: '1930', id: 'acc-2' }],
        // Re-resolution after backfill: all present
        [
          { account_number: '2440', id: 'acc-1' },
          { account_number: '1930', id: 'acc-2' },
          { account_number: '3740', id: 'acc-3' },
        ],
      ],
    })

    const entry = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2026-06-08',
      description: 'Utbetalning leverantörsfaktura',
      source_type: 'supplier_invoice_paid',
      lines: LINES,
    })

    expect(entry.id).toBe('entry-1')
    expect(mockBackfill).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', ['3740'])
  })

  it('still throws AccountsNotInChartError when the account is not seedable', async () => {
    mockBackfill.mockResolvedValue([])
    const supabase = buildSupabase({
      chartByCall: [
        [{ account_number: '2440', id: 'acc-1' }, { account_number: '1930', id: 'acc-2' }],
      ],
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-06-08',
        description: 'Utbetalning leverantörsfaktura',
        source_type: 'supplier_invoice_paid',
        lines: LINES,
      })
    ).rejects.toThrow(AccountsNotInChartError)

    expect(mockBackfill).toHaveBeenCalledTimes(1)
  })
})

describe('reverseEntry: entry_date defaults to original entry date', () => {
  it('uses original entry_date when no reversalDate is provided', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]

    let insertedEntryDate: string | undefined
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: unknown) => {
        const p = payload as Record<string, unknown>
        if (p.entry_date !== undefined) insertedEntryDate = p.entry_date as string
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(insertedEntryDate).toBe('2024-11-15')
  })

  it('uses explicit reversalDate when provided', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]

    let insertedEntryDate: string | undefined
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: unknown) => {
        const p = payload as Record<string, unknown>
        if (p.entry_date !== undefined) insertedEntryDate = p.entry_date as string
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    // A date inside the original's fiscal year (2024): a storno is numbered
    // and attributed there, so the target check refuses any other year.
    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1', '2024-12-31')

    expect(insertedEntryDate).toBe('2024-12-31')
    expect(mockAssertStornoTarget).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ fiscal_period_id: 'period-1', entry_date: '2024-11-15' }),
      '2024-12-31',
    )
  })
})

// BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18: the storno is its own verifikation
// in the original's series and year. A date outside that year, or a locked or
// closed year, is refused before next_voucher_number is called, so a refused
// storno never burns a number (the period-lock trigger refused only the
// insert, after the sequence had moved on).
describe('reverseEntry: refused targets draw no voucher number', () => {
  const original = {
    id: 'entry-1',
    company_id: 'company-1',
    status: 'posted',
    fiscal_period_id: 'period-2025',
    voucher_series: 'A',
    voucher_number: 3,
    entry_date: '2025-11-15',
    description: 'Hyra november',
    source_type: 'manual',
    source_id: null,
    lines: [
      { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
    ],
  }

  function client() {
    const inserts: unknown[] = []
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation(() => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
        b.insert = vi.fn().mockImplementation((payload: unknown) => {
          inserts.push(payload)
          return b
        })
        b.single = vi.fn().mockResolvedValue({ data: original, error: null })
        b.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
        b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        return b
      }),
    }
    return { supabase, inserts }
  }

  it.each([
    ['a date in another fiscal year', new EntryDateOutsideFiscalPeriodError('2026-01-10', '2025', '2025-01-01', '2025-12-31')],
    ['a locked year', new TargetPeriodLockedError('2025-11-15', '2026-01-20T10:00:00Z')],
    ['a closed year', new TargetPeriodClosedError('2025-11-15')],
  ])('%s', async (_label, refusal) => {
    mockAssertStornoTarget.mockRejectedValueOnce(refusal)
    const { supabase, inserts } = client()

    await expect(
      reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1', '2026-01-10'),
    ).rejects.toBe(refusal)

    expect(supabase.rpc).not.toHaveBeenCalledWith('next_voucher_number', expect.anything())
    expect(inserts).toEqual([])
  })
})

// The note describes the affärshändelse. A storno cancels the event instead
// of representing it, so it takes no note; the reversed original keeps its
// own. The correcting verifikat is what carries the note (storno-service).
describe('reverseEntry: the storno carries no note (crm#1078)', () => {
  it('leaves notes off the storno header even when the original has a note', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      notes: 'Avser lokalen på plan 2',
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]

    const headerInserts: Array<Record<string, unknown>> = []
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: unknown) => {
        headerInserts.push(payload as Record<string, unknown>)
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(headerInserts).toHaveLength(1)
    expect(headerInserts[0]).toMatchObject({ source_type: 'storno', reverses_id: 'entry-1' })
    expect(headerInserts[0]).not.toHaveProperty('notes')
  })
})

// The storno is a draft without a number until commit_journal_entry posts
// it, so a failure before that draws no number and leaves no gap to explain.
describe('reverseEntry: no voucher number before the commit', () => {
  it('draws no number when account resolution fails before the reversal insert', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'B',
      voucher_number: 41,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 42, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') {
          const chain = createMockChain({ singleData: original })
          return chain
        }
        if (table === 'chart_of_accounts') {
          const chain: Record<string, unknown> = {}
          for (const method of ['select', 'eq', 'in']) {
            chain[method] = vi.fn().mockReturnValue(chain)
          }
          chain.then = (resolve: (value: unknown) => void) =>
            resolve({ data: null, error: { message: 'account lookup failed' } })
          return chain
        }
        return createMockChain()
      }),
    }

    let caught: unknown
    try {
      await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(BookkeepingDatabaseError)
    expect(getUnusedVoucherAllocation(caught)).toBeNull()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('cancels the unnumbered draft when its lines fail, and never posts it', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'B',
      voucher_number: 41,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }
    const cancelUpdate = vi.fn()
    const deleteLines = vi.fn()
    let journalEntryCall = 0
    let journalLineCall = 0

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 42, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') {
          journalEntryCall += 1
          if (journalEntryCall === 1) return createMockChain({ singleData: original })
          if (journalEntryCall === 2) return createMockChain({ singleData: reversal })
          return {
            update: cancelUpdate.mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          const chain: Record<string, unknown> = {}
          for (const method of ['select', 'eq', 'in']) {
            chain[method] = vi.fn().mockReturnValue(chain)
          }
          chain.then = (resolve: (value: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-5010', account_number: '5010' },
                { id: 'acc-1930', account_number: '1930' },
              ],
              error: null,
            })
          return chain
        }
        if (table === 'journal_entry_lines') {
          journalLineCall += 1
          if (journalLineCall === 1) {
            return {
              insert: vi.fn().mockResolvedValue({ error: { message: 'line insert failed' } }),
            }
          }
          return {
            delete: deleteLines.mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }
        }
        return createMockChain()
      }),
    }

    let caught: unknown
    try {
      await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(BookkeepingDatabaseError)
    expect(getUnusedVoucherAllocation(caught)).toBeNull()
    expect(cancelUpdate).toHaveBeenCalledWith({ status: 'cancelled' })
    expect(deleteLines).toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('reverseEntry: orphan reversal cleanup goes through the gated door', () => {
  // posted -> cancelled is refused by the database for a direct UPDATE
  // (migration 20260929220100). Once the reversal may be posted, its cleanup
  // must call cancel_orphaned_entry, which also keeps the orphan's lines.
  const original = {
    id: 'entry-1',
    company_id: 'company-1',
    status: 'posted',
    fiscal_period_id: 'period-1',
    voucher_series: 'A',
    voucher_number: 7,
    entry_date: '2026-02-02',
    description: 'Hyra februari',
    source_type: 'manual',
    source_id: null,
    lines: [
      { account_number: '5010', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ],
  }
  const reversal = { id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }

  function setup(opts: { postError?: { message: string }; casData?: unknown[] }) {
    let jeCall = 0
    const jeResults = [
      { data: original, error: null }, // fetch original (.single)
      { data: reversal, error: null }, // insert reversal (.single)
      { data: opts.casData ?? [], error: null }, // CAS original -> reversed (await)
    ]
    const jeUpdates: unknown[] = []
    const lineDeletes: unknown[] = []

    const supabase = {
      rpc: vi.fn().mockImplementation(async (name: string) =>
        name === 'cancel_orphaned_entry'
          ? { data: { cancelled: true }, error: null }
          : name === 'commit_journal_entry' // post reversal
            ? { data: opts.postError ? null : [{ voucher_number: 8 }], error: opts.postError ?? null }
            : { data: 8, error: null },
      ),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'insert']) b[m] = vi.fn().mockReturnValue(b)
          b.update = vi.fn().mockImplementation((payload: unknown) => {
            jeUpdates.push(payload)
            return b
          })
          b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
          b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
          return b
        }
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-5010', account_number: '5010' },
                { id: 'acc-1930', account_number: '1930' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
            delete: vi.fn().mockImplementation(() => {
              lineDeletes.push(true)
              return { eq: vi.fn().mockResolvedValue({ error: null }) }
            }),
          }
        }
        return createMockChain()
      }),
    }
    return { supabase, jeUpdates, lineDeletes }
  }

  const expectedRpcArgs = {
    p_company_id: 'company-1',
    p_entry_id: 'reversal-1',
    p_user_id: 'user-1',
    p_gap_explanation: null,
  }

  it('cancels the orphaned reversal through cancel_orphaned_entry when the CAS loses', async () => {
    const { supabase, jeUpdates, lineDeletes } = setup({ casData: [] })

    await expect(
      reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1'),
    ).rejects.toThrow(/already reversed/i)

    expect(supabase.rpc).toHaveBeenCalledWith('cancel_orphaned_entry', expectedRpcArgs)
    expect(jeUpdates).not.toContainEqual({ status: 'cancelled' })
    expect(lineDeletes).toHaveLength(0)
  })

  it('cancels through cancel_orphaned_entry when posting the reversal fails', async () => {
    const { supabase, jeUpdates, lineDeletes } = setup({ postError: { message: 'post failed' } })

    await expect(
      reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1'),
    ).rejects.toThrow(BookkeepingDatabaseError)

    expect(supabase.rpc).toHaveBeenCalledWith('cancel_orphaned_entry', expectedRpcArgs)
    expect(jeUpdates).not.toContainEqual({ status: 'cancelled' })
    expect(lineDeletes).toHaveLength(0)
  })
})

// WHO on a storno or rättelse: the new verifikat is posted through
// commit_journal_entry with the actor of the surrounding scope, so
// committed_actor_* and commit_method are stamped like any other commit and
// the audit_log COMMIT row names the actor instead of defaulting to 'user'.
describe('commitStornoOrCorrectionDraft', () => {
  function rpcClient(result: { data: unknown; error: unknown } = { data: [{ voucher_number: 9 }], error: null }) {
    return { rpc: vi.fn().mockResolvedValue(result) }
  }

  it.each([
    [{ type: 'user' as const }, 'user_accept', 'user', null],
    [{ type: 'api_key' as const, label: 'Bokföringsbyrån' }, 'api_key', 'api_key', 'Bokföringsbyrån'],
    [{ type: 'mcp_oauth' as const, label: 'Claude (Anthropic)' }, 'api_key', 'mcp_oauth', 'Claude (Anthropic)'],
    [{ type: 'cron' as const, label: 'cron.accrual_postings' }, null, 'cron', 'cron.accrual_postings'],
  ])('stamps %o through commit_journal_entry', async (actor, method, type, label) => {
    const supabase = rpcClient()

    const { error } = await runWithActor(actor, () =>
      commitStornoOrCorrectionDraft(supabase as never, 'company-1', 'storno-1'),
    )

    expect(error).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledExactlyOnceWith('commit_journal_entry', {
      p_company_id: 'company-1',
      p_entry_id: 'storno-1',
      p_commit_method: method,
      p_rubric_version: null,
      p_actor_type: type,
      p_actor_label: label,
    })
  })

  it('records no actor outside a scope, as commitEntry does', async () => {
    const supabase = rpcClient()

    await commitStornoOrCorrectionDraft(supabase as never, 'company-1', 'storno-1')

    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', expect.objectContaining({
      p_commit_method: null,
      p_actor_type: null,
      p_actor_label: null,
    }))
  })

  it('returns the RPC refusal instead of throwing', async () => {
    const supabase = rpcClient({ data: null, error: { message: 'unbalanced', code: '23514' } })

    const { error } = await commitStornoOrCorrectionDraft(supabase as never, 'company-1', 'storno-1')

    expect(error).toEqual({ message: 'unbalanced', code: '23514' })
  })
})

describe('reverseEntry: the storno records who committed it', () => {
  it('posts an unnumbered storno draft through commit_journal_entry with the acting key', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }
    let jeCall = 0
    const jeResults = [
      { data: original, error: null }, // fetch original
      { data: reversal, error: null }, // insert storno draft
      { data: [{ id: 'entry-1' }], error: null }, // CAS original -> reversed
      { data: { ...reversal, lines: [] }, error: null }, // fetch complete storno
    ]
    const headerInserts: Array<Record<string, unknown>> = []
    const headerUpdates: Array<Record<string, unknown>> = []
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        headerInserts.push(payload)
        return b
      })
      b.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        headerUpdates.push(payload)
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [{ voucher_number: 4 }], error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    await runWithActor({ type: 'api_key', label: 'Bokföringsbyrån' }, () =>
      reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1'),
    )

    expect(headerInserts).toEqual([
      expect.objectContaining({ source_type: 'storno', status: 'draft', voucher_number: 0 }),
    ])
    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'company-1',
      p_entry_id: 'reversal-1',
      p_commit_method: 'api_key',
      p_rubric_version: null,
      p_actor_type: 'api_key',
      p_actor_label: 'Bokföringsbyrån',
    })
    expect(supabase.rpc).not.toHaveBeenCalledWith('next_voucher_number', expect.anything())
    // Never a client-side post: the only header update is the original's
    // CAS to reversed, which writes no commit stamp.
    expect(headerUpdates).toEqual([{ status: 'reversed', reversed_by_id: 'reversal-1' }])
  })
})

describe('cancelOrphanedEntry', () => {
  it('calls the gated RPC with the actor and the optional gap explanation', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { cancelled: true }, error: null })

    const result = await cancelOrphanedEntry({ rpc } as never, 'company-1', 'user-1', 'je-1', {
      gapExplanation: 'Automatiskt makulerad: test',
    })

    expect(result).toEqual({ error: null })
    expect(rpc).toHaveBeenCalledWith('cancel_orphaned_entry', {
      p_company_id: 'company-1',
      p_entry_id: 'je-1',
      p_user_id: 'user-1',
      p_gap_explanation: 'Automatiskt makulerad: test',
    })
  })

  it('returns the refusal instead of throwing', async () => {
    const refusal = { message: 'was not posted within the last 15 minutes', code: '55000' }
    const rpc = vi.fn().mockResolvedValue({ data: null, error: refusal })

    await expect(
      cancelOrphanedEntry({ rpc } as never, 'company-1', 'user-1', 'je-1'),
    ).resolves.toEqual({ error: refusal })
  })

  it('never throws when the client rejects', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('network blip'))

    await expect(
      cancelOrphanedEntry({ rpc } as never, 'company-1', 'user-1', 'je-1'),
    ).resolves.toEqual({ error: { message: 'network blip' } })
  })
})

describe('reverseEntry: storno guard', () => {
  // BFL 5 kap 5§: a storno-of-a-storno makes the original verifikat's
  // cancellation chain ambiguous, so stornos are never reversible. A
  // correction entry, by contrast, is a regular live verifikation (it can be
  // a duplicate of an affärshändelse booked by another verifikat) and must
  // stay reversible: the guard covers 'storno' only.
  function supabaseReturningOriginal(original: Record<string, unknown>) {
    return {
      rpc: vi.fn(),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'update', 'insert']) b[m] = vi.fn().mockReturnValue(b)
          b.single = vi.fn().mockResolvedValue({ data: original, error: null })
          return b
        }
        return createMockChain()
      }),
    }
  }

  it(`throws CannotReverseStornoError for source_type 'storno'`, async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Makulering: Hyra november',
      source_type: 'storno',
      source_id: null,
      lines: [
        { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
        { account_number: '5010', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const supabase = supabaseReturningOriginal(original)

    await expect(
      reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1'),
    ).rejects.toBeInstanceOf(CannotReverseStornoError)

    // No reversal was written: the guard fires before any voucher number is drawn.
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it(`reverses a correction entry like any regular verifikat`, async () => {
    // A rättelseverifikation that turned out to duplicate another booking
    // (support case 2026-07-26) is nullified with a normal storno; the
    // correction_of_id link keeps the chain traceable.
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Rättelse: Hyra november',
      source_type: 'correction',
      source_id: null,
      correction_of_id: 'entry-0',
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      // The verifikat the correction corrects (correctedOriginalOf): a
      // manual one, whose storno runs no rule of its own.
      {
        data: {
          id: 'entry-0',
          correction_of_id: null,
          reverses_id: null,
          voucher_series: 'A',
          voucher_number: 1,
          source_type: 'manual',
          source_id: null,
        },
        error: null,
      },
      // Chain-depth walker: follows correction_of_id to the chain root
      // (depth 1, well under the guard threshold).
      { data: { id: 'entry-0', correction_of_id: null, reverses_id: null, voucher_series: 'A', voucher_number: 1 }, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]

    let insertedEntry: Record<string, unknown> | undefined
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: unknown) => {
        insertedEntry = payload as Record<string, unknown>
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(insertedEntry).toBeDefined()
    expect(insertedEntry!.source_type).toBe('storno')
    expect(insertedEntry!.reverses_id).toBe('entry-1')
    expect(insertedEntry!.description).toBe('Makulering: Rättelse: Hyra november')
  })
})

describe('reverseEntry: collections', () => {
  function original(overrides: Record<string, unknown>) {
    return {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'C',
      voucher_number: 3,
      entry_date: '2026-09-27',
      description: 'Inbetalning',
      source_id: null,
      lines: [
        { account_number: '1689', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
      ],
      ...overrides,
    }
  }

  function supabaseFor(entry: Record<string, unknown>, collectionsRows: { id: string }[], rebookRows: { id: string }[] = []) {
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }
    let jeCall = 0
    const jeResults = [
      { data: entry, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]
    const paymentFilters: unknown[][] = []
    const rebookFilters: unknown[][] = []
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) b[m] = vi.fn().mockReturnValue(b)
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }
    function paymentsBuilder() {
      const b: Record<string, unknown> = {}
      b.select = vi.fn().mockReturnValue(b)
      b.eq = vi.fn().mockImplementation((...args: unknown[]) => {
        paymentFilters.push(args)
        return b
      })
      b.limit = vi.fn().mockResolvedValue({ data: collectionsRows, error: null })
      return b
    }
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'invoice_payments') return paymentsBuilder()
        if (table === 'collection_collected_payments') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'is', 'gt']) {
            b[m] = vi.fn().mockImplementation((...args: unknown[]) => {
              rebookFilters.push([m, ...args])
              return b
            })
          }
          b.limit = vi.fn().mockResolvedValue({ data: rebookRows, error: null })
          return b
        }
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-1689', account_number: '1689' },
                { id: 'acc-1510', account_number: '1510' },
                { id: 'acc-1930', account_number: '1930' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }
    return { supabase, paymentFilters, rebookFilters }
  }

  beforeEach(() => {
    mockReleaseSettlement.mockClear()
  })

  it('refuses a generic storno of a payment the collections provider collected, before any voucher number is drawn', async () => {
    const { supabase, paymentFilters } = supabaseFor(original({ source_type: 'invoice_paid' }), [{ id: 'ip-1' }])
    await expect(reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')).rejects.toBeInstanceOf(
      CannotReverseCollectedPaymentError,
    )
    expect(paymentFilters).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['journal_entry_id', 'entry-1'],
        ['source', 'collections'],
      ]),
    )
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('lets the collections rebook storno through while it holds the payment, and only then', async () => {
    const held = supabaseFor(original({ source_type: 'invoice_paid' }), [{ id: 'ip-1' }], [{ id: 'collected-1' }])
    await expect(
      reverseEntry(held.supabase as never, 'company-1', 'user-1', 'entry-1', undefined, { collectionsRebook: true }),
    ).resolves.toMatchObject({ id: 'reversal-1' })
    expect(held.rebookFilters).toEqual(
      expect.arrayContaining([
        ['eq', 'company_id', 'company-1'],
        ['eq', 'journal_entry_id', 'entry-1'],
        ['eq', 'status', 'booked'],
        ['is', 'settlement_id', null],
        ['gt', 'booking_lease_until', expect.any(String)],
      ]),
    )

    // The option alone is not enough: the rebook must hold the payment.
    const notHeld = supabaseFor(original({ source_type: 'invoice_paid' }), [{ id: 'ip-1' }], [])
    await expect(
      reverseEntry(notHeld.supabase as never, 'company-1', 'user-1', 'entry-1', undefined, { collectionsRebook: true }),
    ).rejects.toBeInstanceOf(CannotReverseCollectedPaymentError)
    expect(notHeld.supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns the payout of a reversed payout voucher to the settlements view', async () => {
    const { supabase } = supabaseFor(
      original({
        source_type: 'collection_settlement',
        source_id: 'stl-1',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1689', debit_amount: 0, credit_amount: 1000 },
        ],
      }),
      [],
    )
    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')
    expect(mockReleaseSettlement).toHaveBeenCalledWith('company-1', 'entry-1')
    // A payout voucher carries no invoice payment: the collected-payment guard does not apply.
    expect(supabase.from).not.toHaveBeenCalledWith('invoice_payments')
  })

  it('refuses a generic storno of a recovery booked from a collected payment; the rebook holding it goes through', async () => {
    mockAssertCustomerLossReversible.mockClear()
    mockSyncCustomerLoss.mockClear()
    const recovery = original({ source_type: 'customer_loss', voucher_series: 'A', source_id: 'decision-1', description: 'Återvunnen kundförlust' })
    const generic = supabaseFor(recovery, [], [{ id: 'collected-1' }])
    await expect(reverseEntry(generic.supabase as never, 'company-1', 'user-1', 'entry-1')).rejects.toBeInstanceOf(
      CannotReverseCollectedPaymentError,
    )
    expect(generic.rebookFilters).toEqual(expect.arrayContaining([['eq', 'journal_entry_id', 'entry-1']]))
    expect(generic.supabase.rpc).not.toHaveBeenCalled()
    expect(mockAssertCustomerLossReversible).not.toHaveBeenCalled()

    const held = supabaseFor(recovery, [], [{ id: 'collected-1' }])
    await expect(
      reverseEntry(held.supabase as never, 'company-1', 'user-1', 'entry-1', undefined, { collectionsRebook: true }),
    ).resolves.toMatchObject({ id: 'reversal-1' })
    expect(held.rebookFilters).toEqual(expect.arrayContaining([['gt', 'booking_lease_until', expect.any(String)]]))
    expect(mockAssertCustomerLossReversible).toHaveBeenCalledWith(expect.anything(), 'company-1', 'entry-1')
    expect(mockSyncCustomerLoss).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'entry-1', expect.objectContaining({ id: 'reversal-1' }))
    // A recovery carries no invoice payment row: the payment guard never looks.
    expect(held.supabase.from).not.toHaveBeenCalledWith('invoice_payments')
  })

  it('leaves a kundförlust voucher no collected payment holds to the generic storno', async () => {
    const { supabase } = supabaseFor(original({ source_type: 'customer_loss', voucher_series: 'A', source_id: 'decision-2' }), [], [])
    await expect(reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')).resolves.toMatchObject({ id: 'reversal-1' })
  })
})

describe('reverseEntry: bank transaction unlink', () => {
  // After a reversal the booked bank transaction must return to "Att bokföra"
  // so the user can book it again. The agent paths in
  // lib/pending-operations/commit.ts did this manually; the engine now owns
  // it so the dashboard reverse route behaves the same.
  //
  // "Att bokföra" is is_business IS NULL AND is_ignored = false
  // (lib/worklist/types.ts), not journal_entry_id IS NULL: bulk-booked and
  // multi-allocated rows keep journal_entry_id NULL while booked. Clearing
  // only the link therefore left the stornoed row out of the list and the nav
  // badge (#1950), so the engine resets the same triple the uncategorize
  // paths write, plus reconciliation_method since the link it described is gone.
  //
  // Second anchor: bulk-booked rows (bulk_book_transactions RPC) point at the
  // verifikat through transaction_voucher_links, and for N>1 that junction is
  // the only anchor. The engine deletes those link rows and releases the rows
  // that have no anchor left; a row still anchored elsewhere (residual booking:
  // main verifikat in journal_entry_id, junction row to the residual verifikat)
  // stays booked.
  const original = {
    id: 'entry-1',
    company_id: 'company-1',
    status: 'posted',
    fiscal_period_id: 'period-1',
    voucher_series: 'A',
    voucher_number: 7,
    entry_date: '2026-02-02',
    description: 'ALMI AB - Innovationslån',
    source_type: 'manual',
    source_id: null,
    lines: [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2350', debit_amount: 0, credit_amount: 1000 },
    ],
  }
  const reversal = { id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }

  type Filter = [op: string, column: string, value: unknown]
  interface RecordedWrite { payload?: unknown; op?: string; filters: Filter[] }

  type RemainingRow = { transaction_id: string; role?: string; allocated_amount?: number }
  type TxRow = { id: string; amount: number; journal_entry_id: string | null }

  /**
   * Mock for reverseEntry. `voucherLinks` are the transaction ids the junction
   * holds for entry-1; `remainingLinks` what it still holds for those ids after
   * the delete (a row anchored to some other verifikat too), as ids (one
   * bank_line row each, no amount) or as full rows. `txRows` is what the
   * partial-split read returns for the rows that still have anchors.
   * `release` is what the release_reversed_entry_transactions RPC answers
   * (the pointer reset and the supplementary-link drop live in that RPC since
   * #2061; its semantics are pinned in tests/pg/release-reversed-entry-
   * transactions.pg.test.ts, here only the call and the fallthrough are).
   */
  function setup(
    opts: {
      voucherLinks?: string[]
      remainingLinks?: Array<string | RemainingRow>
      txRows?: TxRow[]
      release?: { data: unknown; error: unknown }
    } = {},
  ) {
    let jeCall = 0
    const jeResults = [
      { data: original, error: null },                   // fetch original (.single)
      { data: reversal, error: null },                   // insert reversal (.single)
      { data: [{ id: 'entry-1' }], error: null },        // CAS original → reversed (await)
      { data: { ...reversal, lines: [] }, error: null }, // fetch complete (.single)
    ]
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const txWrites: RecordedWrite[] = []
    const linkOps: RecordedWrite[] = []
    let linkSelectCall = 0

    function recorder(list: RecordedWrite[], resolveWith: (current: RecordedWrite) => unknown) {
      const b: Record<string, unknown> = {}
      let current: RecordedWrite = { filters: [] }
      const start = (op: string) =>
        vi.fn().mockImplementation((payload?: unknown) => {
          current = { op, payload, filters: [] }
          list.push(current)
          return b
        })
      const filter = (op: string) =>
        vi.fn().mockImplementation((column: string, value: unknown) => {
          current.filters.push([op, column, value])
          return b
        })
      b.update = start('update')
      b.select = start('select')
      b.delete = start('delete')
      b.eq = filter('eq')
      b.in = filter('in')
      b.is = filter('is')
      b.neq = filter('neq')
      b.then = (resolve: (v: unknown) => void) => resolve(resolveWith(current))
      return b
    }

    const supabase = {
      rpc: vi.fn().mockImplementation(async (name: string) =>
        name === 'release_reversed_entry_transactions'
          ? (opts.release ?? { data: { released: 0, dropped: 0 }, error: null })
          : { data: 8, error: null },
      ),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-1930', account_number: '1930' },
                { id: 'acc-2350', account_number: '2350' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        if (table === 'transactions') {
          return recorder(txWrites, (current) =>
            current.op === 'select' ? { data: opts.txRows ?? [], error: null } : { error: null },
          )
        }
        if (table === 'transaction_voucher_links') {
          return recorder(linkOps, (current) => {
            if (current.op !== 'select') return { error: null }
            if (linkSelectCall++ === 0) {
              return { data: (opts.voucherLinks ?? []).map((transaction_id) => ({ transaction_id })), error: null }
            }
            const rows = (opts.remainingLinks ?? []).map((r) =>
              typeof r === 'string' ? { transaction_id: r, role: 'bank_line', allocated_amount: 0 } : r,
            )
            return { data: rows, error: null }
          })
        }
        return createMockChain()
      }),
    }

    return { supabase, txWrites, linkOps }
  }

  it('resets journal_entry_id, is_business and category so the row returns to Att bokföra (#1950)', async () => {
    const { supabase, txWrites, linkOps } = setup({
      release: { data: { released: 1, dropped: 1 }, error: null },
    })

    const result = await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(result.id).toBe('reversal-1')
    // The pointer reset (journal_entry_id, is_business, category,
    // reconciliation_method to null) and the drop of the released rows'
    // supplementary junction links run inside one RPC statement (#2061),
    // scoped to this company and this entry: never a company-wide reset.
    expect(supabase.rpc).toHaveBeenCalledWith('release_reversed_entry_transactions', {
      p_company_id: 'company-1',
      p_entry_id: 'entry-1',
    })
    // No direct write to transactions is left on this path.
    expect(txWrites).toHaveLength(0)
    // The junction is consulted for this entry only; nothing to delete or
    // release when it holds no rows.
    expect(linkOps).toEqual([
      {
        op: 'select',
        payload: 'transaction_id',
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['eq', 'journal_entry_id', 'entry-1'],
        ],
      },
    ])
  })

  it('deletes transaction_voucher_links rows and releases bulk-booked rows with no anchor left', async () => {
    // Samlingsverifikat over three bank rows (journal_entry_id NULL on all
    // three, one junction row each). tx-c is also anchored to another
    // verifikat through the junction and must stay booked.
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-a', 'tx-b', 'tx-c'],
      remainingLinks: ['tx-c'],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps).toEqual([
      {
        op: 'select',
        payload: 'transaction_id',
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['eq', 'journal_entry_id', 'entry-1'],
        ],
      },
      {
        op: 'delete',
        payload: undefined,
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['eq', 'journal_entry_id', 'entry-1'],
        ],
      },
      {
        op: 'select',
        payload: 'transaction_id, role, allocated_amount',
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['in', 'transaction_id', ['tx-a', 'tx-b', 'tx-c']],
        ],
      },
    ])

    // [0] the partial-split read for the row still anchored (tx-c), [1] the
    // release of the rows with no anchor left.
    expect(txWrites).toHaveLength(2)
    expect(txWrites[0]).toEqual({
      op: 'select',
      payload: 'id, amount, journal_entry_id',
      filters: [
        ['eq', 'company_id', 'company-1'],
        ['in', 'id', ['tx-c']],
      ],
    })
    expect(txWrites[1].payload).toEqual({ is_business: null, category: null, reconciliation_method: null })
    // Only rows with no anchor left, and never a row whose journal_entry_id
    // still points at another verifikat (residual booking).
    expect(txWrites[1].filters).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['in', 'id', ['tx-a', 'tx-b']],
      ['is', 'journal_entry_id', null],
    ])
  })

  it('leaves the rows alone when every junction-linked row is still anchored elsewhere', async () => {
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-a'],
      remainingLinks: ['tx-a'],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps.map((o) => o.op)).toEqual(['select', 'delete', 'select'])
    // Only the partial-split read; no release.
    expect(txWrites.map((w) => w.op)).toEqual(['select'])
  })

  it('releases a 1:N split whole when one of its verifikat is reversed (#1553): surviving slices dropped', async () => {
    // tx-s (amount -800) was split over entry-1 (-500) and entry-2 (-300).
    // Reversing entry-1 leaves a -300 bank_line slice that no longer explains
    // the row: the slice goes, and the row returns to Att bokföra.
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-s'],
      remainingLinks: [{ transaction_id: 'tx-s', role: 'bank_line', allocated_amount: -300 }],
      txRows: [{ id: 'tx-s', amount: -800, journal_entry_id: null }],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps.map((o) => o.op)).toEqual(['select', 'delete', 'select', 'delete'])
    expect(linkOps[3].filters).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['in', 'transaction_id', ['tx-s']],
    ])
    const release = txWrites[txWrites.length - 1]
    expect(release.op).toBe('update')
    expect(release.payload).toEqual({ is_business: null, category: null, reconciliation_method: null })
    expect(release.filters).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['in', 'id', ['tx-s']],
      ['is', 'journal_entry_id', null],
    ])
  })

  it('keeps a row whose surviving slices still sum to its amount, or that carries a non-bank_line anchor', async () => {
    // tx-full: a bulk-booked-style anchor on another verifikat covering the
    // whole amount. tx-res: a residual booking's 'other' row whose main
    // verifikat pointer is already null (a row left behind before the main
    // storno started dropping such links, #2061); the residual row is not a
    // slice and the partial-split judgement never touches it.
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-full', 'tx-res'],
      remainingLinks: [
        { transaction_id: 'tx-full', role: 'bank_line', allocated_amount: -800 },
        { transaction_id: 'tx-res', role: 'other', allocated_amount: -10 },
      ],
      txRows: [
        { id: 'tx-full', amount: -800, journal_entry_id: null },
        { id: 'tx-res', amount: -1010, journal_entry_id: null },
      ],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps.map((o) => o.op)).toEqual(['select', 'delete', 'select'])
    expect(txWrites.map((w) => w.op)).toEqual(['select'])
  })

  it('runs the release RPC before the junction cleanup, and the storno still completes when the RPC fails', async () => {
    // The release is best effort like the junction cleanup below it: the
    // storno is already posted by then, so an RPC error is logged and the
    // entry-scoped junction cleanup still runs.
    const { supabase, txWrites, linkOps } = setup({
      release: { data: null, error: { message: 'boom' } },
    })

    const result = await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(result.id).toBe('reversal-1')
    const rpcNames = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(rpcNames).toContain('release_reversed_entry_transactions')
    expect(linkOps.map((o) => o.op)).toEqual(['select'])
    expect(txWrites).toHaveLength(0)
  })
})

describe('reverseEntry: opening balance unlink', () => {
  // Reversing a period's IB verifikat must also drop the period's pointer to
  // it. getOpeningBalances() reads the linked entry's lines with no status
  // filter, so a still-linked cancelled IB keeps showing in the Balansrapport,
  // and year-end refuses to run while the pointer is non-null: the storno its
  // own error message asks for could never satisfy it. See engine.pg.test.ts
  // for why the flag must fall before the pointer.
  function buildSupabase(sourceType: string) {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 1,
      entry_date: '2026-01-01',
      description: 'Ingående balanser från SIE-import',
      source_type: sourceType,
      source_id: null,
      lines: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2350', debit_amount: 0, credit_amount: 1000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const fpUpdates: unknown[] = []
    const fpFilters: Record<string, unknown>[] = []

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 2, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-1930', account_number: '1930' },
                { id: 'acc-2350', account_number: '2350' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        if (table === 'fiscal_periods') {
          const b: Record<string, unknown> = {}
          const filters: Record<string, unknown> = {}
          b.update = vi.fn().mockImplementation((payload: unknown) => {
            fpUpdates.push(payload)
            fpFilters.push(filters)
            return b
          })
          b.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
            filters[col] = val
            return b
          })
          b.then = (resolve: (v: unknown) => void) => resolve({ error: null })
          return b
        }
        if (table === 'transactions') {
          const b: Record<string, unknown> = {}
          for (const m of ['update', 'eq']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) => resolve({ error: null })
          return b
        }
        return createMockChain()
      }),
    }

    return { supabase, fpUpdates, fpFilters }
  }

  it('clears the period IB link, flag before pointer, for an opening_balance entry', async () => {
    const { supabase, fpUpdates, fpFilters } = buildSupabase('opening_balance')

    const result = await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(result.id).toBe('reversal-1')
    // Order matters: enforce_opening_balance_immutability rejects the pointer
    // write while opening_balances_set is still true.
    expect(fpUpdates).toEqual([{ opening_balances_set: false }, { opening_balance_entry_id: null }])
    // Scoped to this entry, so a period pointing elsewhere is untouched.
    for (const f of fpFilters) {
      expect(f).toMatchObject({ company_id: 'company-1', opening_balance_entry_id: 'entry-1' })
    }
  })

  it('leaves fiscal_periods untouched for a non-opening_balance entry', async () => {
    const { supabase, fpUpdates } = buildSupabase('manual')

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(fpUpdates).toEqual([])
  })
})

describe('reverseEntry: depreciation schedule release', () => {
  // A register-posted avskrivning links its depreciation_schedules row to the
  // voucher. Reversing the voucher must release that row, or the register
  // keeps counting a cancelled avskrivning and commit_asset_depreciation
  // refuses to book the period again. The trigger side (release allowed only
  // with a posted storno) is pinned in
  // tests/pg/depreciation-schedule-storno-release.pg.test.ts.
  function buildSupabase(sourceType: string, releaseError: unknown = null) {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'I',
      voucher_number: 1,
      entry_date: '2026-08-31',
      description: 'Planenlig avskrivning 2025/26: Dator',
      source_type: sourceType,
      source_id: null,
      lines: [
        { account_number: '7832', debit_amount: 2059, credit_amount: 0 },
        { account_number: '1229', debit_amount: 0, credit_amount: 2059 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const dsUpdates: unknown[] = []
    const dsFilters: Record<string, unknown>[] = []

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 2, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-7832', account_number: '7832' },
                { id: 'acc-1229', account_number: '1229' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        if (table === 'depreciation_schedules') {
          const b: Record<string, unknown> = {}
          const filters: Record<string, unknown> = {}
          b.update = vi.fn().mockImplementation((payload: unknown) => {
            dsUpdates.push(payload)
            dsFilters.push(filters)
            return b
          })
          b.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
            filters[col] = val
            return b
          })
          b.then = (resolve: (v: unknown) => void) => resolve({ error: releaseError })
          return b
        }
        return createMockChain()
      }),
    }

    return { supabase, dsUpdates, dsFilters }
  }

  it('releases the schedule row linked to a reversed year_end voucher', async () => {
    const { supabase, dsUpdates, dsFilters } = buildSupabase('year_end')

    const result = await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(result.id).toBe('reversal-1')
    // Link and posted flag fall together: the trigger accepts exactly this.
    expect(dsUpdates).toEqual([{ journal_entry_id: null, posted_at: null }])
    // Scoped to this company and this voucher only.
    expect(dsFilters).toEqual([{ company_id: 'company-1', journal_entry_id: 'entry-1' }])
  })

  it('does not touch depreciation_schedules for other source types', async () => {
    const { supabase, dsUpdates } = buildSupabase('manual')

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(dsUpdates).toEqual([])
  })

  it('still returns the posted storno when the release write fails', async () => {
    const { supabase, dsUpdates } = buildSupabase('year_end', {
      message: 'Cannot modify a posted depreciation schedule',
      code: '23514',
    })

    const result = await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(result.id).toBe('reversal-1')
    expect(dsUpdates).toHaveLength(1)
  })
})
