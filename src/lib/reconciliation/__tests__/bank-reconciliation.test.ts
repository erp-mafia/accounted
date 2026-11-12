/**
 * Tests for the bank reconciliation engine.
 *
 * Covers: matching algorithm (4 passes), direction compatibility,
 * greedy assignment, dry run, manual link/unlink, status calculation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The #1290 diagnostic is a log line, so the logger is the assertion surface.
// Hoisted spy (the module is imported at the top of bank-reconciliation.ts).
//
// The REAL logger module is kept and only `warn` is swapped. A file-global stub
// exposing just the handful of methods this suite happens to use would be a trap
// for whoever extends it: vi.mock replaces @/lib/logger for the whole module
// graph of this file, so any module reached from here that calls a level the
// stub omitted, or chains `log.child(...).info(...)`, would throw inside an
// unrelated test. Here child() and every other export stay real.
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      warn: logWarn,
    }),
  }
})

// A link someone chose anchors the row's underlag to the verifikat (crm#1101).
// The propagation itself is tested in lib/transactions/__tests__; here only
// when manualLink asks for it, so every other test keeps it a no-op as before.
const { propagateUnderlag } = vi.hoisted(() => ({ propagateUnderlag: vi.fn() }))
vi.mock('@/lib/transactions/inbox-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/inbox-underlag')>()),
  propagateUnderlagForBookedTransaction: (...args: unknown[]) => propagateUnderlag(...args),
}))

// A link teaches its bank text (crm#1746). The learner itself is tested in
// lib/transactions/__tests__/link-learning.test.ts; here only which evidence
// each door hands it, and that the link stands whatever it answers. The
// spies call the real learner, so every other test runs as before.
const { learnSpy, learnManySpy } = vi.hoisted(() => ({ learnSpy: vi.fn(), learnManySpy: vi.fn() }))
vi.mock('@/lib/transactions/link-learning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transactions/link-learning')>()
  learnSpy.mockImplementation(actual.learnFromBankLink)
  learnManySpy.mockImplementation(actual.learnFromBankLinks)
  return {
    ...actual,
    learnFromBankLink: (...args: Parameters<typeof actual.learnFromBankLink>) => learnSpy(...args),
    learnFromBankLinks: (...args: Parameters<typeof actual.learnFromBankLinks>) => learnManySpy(...args),
  }
})

import {
  tryReconcileTransaction,
  runReconciliation,
  manualLink,
  linkTransactionToVouchers,
  unlinkReconciliation,
  isUnlinkableBankLink,
  getReconciliationStatus,
  scopeTransactionsToAccount,
  ledgerLineAmountIn,
  openAmountByEntry,
} from '../bank-reconciliation'
import type { UnlinkedGLLine } from '../bank-reconciliation'
import { ID_READ_CHUNK, MAX_BANK_ROW_SPLIT } from '../limits'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

/** The basis a person's own link records (src/lib/links/link-basis.ts). */
const MANUAL = { linkBasis: { basis: 'user_confirmed' as const } }

vi.mock('@/lib/supabase/server')

// ============================================================
// Helpers
// ============================================================

function makeGLLine(overrides: Partial<UnlinkedGLLine> = {}): UnlinkedGLLine {
  return {
    line_id: `line-${Math.random().toString(36).slice(2, 8)}`,
    journal_entry_id: `je-${Math.random().toString(36).slice(2, 8)}`,
    debit_amount: 0,
    credit_amount: 0,
    line_description: null,
    entry_date: '2024-06-15',
    voucher_number: 1,
    voucher_series: 'A',
    entry_description: 'Test entry',
    source_type: 'import',
    ...overrides,
  }
}

// ============================================================
// ledgerLineAmountIn: the single definition of "this ledger line's amount,
// expressed in the currency the account is being reconciled in"
// ============================================================

describe('ledgerLineAmountIn', () => {
  it('nets debit against credit on SEK, ignoring the currency LABEL', () => {
    // The headline trap: currency-utils stamps `currency: 'EUR'` +
    // amount_in_currency onto a line whose debit_amount is SEK (a EUR supplier
    // invoice paid from a SEK account). Reconciling that account in SEK must
    // use the SEK columns and ignore the label entirely.
    expect(ledgerLineAmountIn({ debit_amount: 1150, credit_amount: 0 }, 'SEK')).toBe(1150)
    expect(ledgerLineAmountIn({ debit_amount: 0, credit_amount: 1150 }, 'SEK')).toBe(-1150)
    expect(
      ledgerLineAmountIn(
        { debit_amount: 1150, credit_amount: 0, currency: 'EUR', amount_in_currency: 100 },
        'SEK',
      ),
    ).toBe(1150)
  })

  it('never returns null on SEK: the 95% path always has an answer', () => {
    expect(ledgerLineAmountIn({ debit_amount: null, credit_amount: null }, 'SEK')).toBe(0)
    expect(ledgerLineAmountIn({ debit_amount: '250.50', credit_amount: '0' }, 'SEK')).toBe(250.5)
  })

  it('returns the FOREIGN amount, not the SEK figure, on a foreign account', () => {
    // 100 EUR booked at 11.50: debit_amount is the 1150 SEK conversion.
    // Reconciling the EUR account must yield 100, never 1150.
    expect(
      ledgerLineAmountIn(
        { debit_amount: 1150, credit_amount: 0, currency: 'EUR', amount_in_currency: 100 },
        'EUR',
      ),
    ).toBe(100)
    expect(
      ledgerLineAmountIn(
        { debit_amount: 0, credit_amount: 1150, currency: 'EUR', amount_in_currency: 100 },
        'EUR',
      ),
    ).toBe(-100)
  })

  it('takes direction from the debit/credit side, magnitude from amount_in_currency', () => {
    // Some rows carry a negatively-signed amount_in_currency; the ledger side is
    // authoritative for direction, so the sign must not be applied twice.
    expect(
      ledgerLineAmountIn(
        { debit_amount: 0, credit_amount: 1150, currency: 'EUR', amount_in_currency: -100 },
        'EUR',
      ),
    ).toBe(-100)
  })

  it('returns null (never the SEK figure) when the line carries no amount in that currency', () => {
    // No rate on the row: a SIE-imported or pre-FX line on a EUR account. There
    // is nothing to convert with, so the caller must report it, not guess.
    expect(ledgerLineAmountIn({ debit_amount: 1150, credit_amount: 0 }, 'EUR')).toBeNull()
    expect(
      ledgerLineAmountIn({ debit_amount: 1150, credit_amount: 0, currency: 'SEK' }, 'EUR'),
    ).toBeNull()
    expect(
      ledgerLineAmountIn(
        { debit_amount: 1150, credit_amount: 0, currency: 'EUR', amount_in_currency: null },
        'EUR',
      ),
    ).toBeNull()
    // Wrong label: a USD line on a EUR account carries no EUR amount.
    expect(
      ledgerLineAmountIn(
        { debit_amount: 1150, credit_amount: 0, currency: 'USD', amount_in_currency: 110 },
        'EUR',
      ),
    ).toBeNull()
  })
})

// ============================================================
// scopeTransactionsToAccount: the per-account query filter
// ============================================================

describe('scopeTransactionsToAccount', () => {
  // Records every filter call and returns itself so the chain can continue.
  function makeQueryStub() {
    const calls: { method: string; args: unknown[] }[] = []
    const self = {
      eq: (...args: unknown[]) => {
        calls.push({ method: 'eq', args })
        return self
      },
      or: (...args: unknown[]) => {
        calls.push({ method: 'or', args })
        return self
      },
    }
    return { self, calls }
  }

  it('scopes by currency AND (this account OR legacy NULL) using a flat two-term or', () => {
    const { self, calls } = makeQueryStub()
    const id = '11111111-1111-1111-1111-111111111111'

    scopeTransactionsToAccount(self as never, id, 'SEK')

    // currency is constrained even on the bound branch (a cash account has one
    // currency), which lets us avoid the fragile nested and() form.
    expect(calls).toContainEqual({ method: 'eq', args: ['currency', 'SEK'] })
    expect(calls).toContainEqual({
      method: 'or',
      args: [`cash_account_id.eq.${id},cash_account_id.is.null`],
    })
    // Regression guard: the old nested `and(cash_account_id.is.null,currency.eq.X)`
    // silently returned ZERO rows mid-backfill: it must never come back.
    const orCall = calls.find((c) => c.method === 'or')
    expect(String(orCall?.args[0])).not.toContain('and(')
  })

  it('scopes strictly to the account (no NULL fallback) when includeUnassigned is false', () => {
    const { self, calls } = makeQueryStub()
    const id = '22222222-2222-2222-2222-222222222222'

    // includeUnassigned=false is the non-primary account case: a secondary
    // same-currency account (e.g. a 1931 savings account) must NOT pull in the
    // company's unassigned NULL rows: those belong to the primary account.
    // Double-counting them inflated the secondary account's bank total and
    // showed a large bogus difference ("1930 works, the other accounts go wonky").
    scopeTransactionsToAccount(self as never, id, 'SEK', false)

    expect(calls).toEqual([
      { method: 'eq', args: ['currency', 'SEK'] },
      { method: 'eq', args: ['cash_account_id', id] },
    ])
    // No OR: the IS NULL fallback must not appear for a non-primary account.
    expect(calls.find((c) => c.method === 'or')).toBeUndefined()
  })

  it('falls back to a pure currency filter when no cash account id is given', () => {
    const { self, calls } = makeQueryStub()

    scopeTransactionsToAccount(self as never, undefined, 'EUR')

    expect(calls).toEqual([{ method: 'eq', args: ['currency', 'EUR'] }])
  })

  it('rejects a non-ISO currency (PostgREST filter-injection guard)', () => {
    const { self } = makeQueryStub()
    expect(() =>
      scopeTransactionsToAccount(self as never, undefined, 'SEK; drop' as never),
    ).toThrow()
  })

  it('rejects a non-uuid cash account id', () => {
    const { self } = makeQueryStub()
    expect(() => scopeTransactionsToAccount(self as never, 'not-a-uuid', 'SEK')).toThrow()
  })
})

// ============================================================
// tryReconcileTransaction: in-memory matching
// ============================================================

describe('tryReconcileTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  // ------------------------------------------------------------------
  // Pass 1: Exact amount + exact date
  // ------------------------------------------------------------------
  it('matches income transaction with exact amount and date (debit on 1930)', () => {
    const tx = makeTransaction({ amount: 5000, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 5000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_exact')
    expect(result!.confidence).toBe(0.95)
  })

  it('matches expense transaction with exact amount and date (credit on 1930)', () => {
    const tx = makeTransaction({ amount: -1200, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1200, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_exact')
    expect(result!.confidence).toBe(0.95)
  })

  // ------------------------------------------------------------------
  // Pass 2: Exact amount + OCR/reference match (within ±90 days)
  // ------------------------------------------------------------------
  it('matches on exact amount with OCR reference match within 90 days', () => {
    const tx = makeTransaction({
      amount: 3500,
      date: '2024-06-20',
      currency: 'SEK',
      reference: '12345678',
    })
    const line = makeGLLine({
      debit_amount: 3500,
      entry_date: '2024-06-10',
      entry_description: 'Payment ref 12345678',
    })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_reference')
    expect(result!.confidence).toBe(0.90)
  })

  // Regression: viktor@frnzn.com: recurring monthly bank fee from 2026 was
  // wrongly reconciled to a 2024 SIE-imported voucher because description +
  // amount collided. auto_reference must require a real OCR token AND a
  // bounded date window: description alone, no date check, is not enough.
  it('does NOT match recurring charge across years on description alone', () => {
    const tx = makeTransaction({
      amount: -149,
      date: '2026-01-31',
      currency: 'SEK',
      description: 'Månadsavgift Baspaket',
      reference: null,
    })
    const line = makeGLLine({
      credit_amount: 149,
      entry_date: '2024-03-31',
      entry_description: 'Bankavgifter Månadsavgift Baspaket',
    })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  it('does NOT match on OCR reference when dates are >90 days apart', () => {
    const tx = makeTransaction({
      amount: 3500,
      date: '2026-06-20',
      currency: 'SEK',
      reference: '12345678',
    })
    const line = makeGLLine({
      debit_amount: 3500,
      entry_date: '2024-06-10',
      entry_description: 'Payment ref 12345678',
    })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Pass 3: Exact amount + date within ±3 days
  // ------------------------------------------------------------------
  it('matches on exact amount within 3 day date range', () => {
    const tx = makeTransaction({ amount: 750, date: '2024-06-17', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 750, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_date_range')
    expect(result!.confidence).toBe(0.85)
  })

  it('does not match when date difference exceeds 3 days', () => {
    const tx = makeTransaction({ amount: 750, date: '2024-06-20', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 750, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    // 5 days apart, no reference, different dates: no match
    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Pass 4: Fuzzy amount (±0.01) + exact date
  // ------------------------------------------------------------------
  it('matches on fuzzy amount with exact date', () => {
    const tx = makeTransaction({ amount: -999.99, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_fuzzy')
    expect(result!.confidence).toBe(0.75)
  })

  it('does not match when fuzzy amount exceeds 0.01 tolerance', () => {
    const tx = makeTransaction({ amount: -999.98, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Direction mismatch rejection
  // ------------------------------------------------------------------
  it('rejects income transaction against credit line (direction mismatch)', () => {
    const tx = makeTransaction({ amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  it('rejects expense transaction against debit line (direction mismatch)', () => {
    const tx = makeTransaction({ amount: -500, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 500, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Non-SEK transactions
  // ------------------------------------------------------------------
  it('skips non-SEK transactions', () => {
    const tx = makeTransaction({ amount: 100, date: '2024-06-15', currency: 'EUR' })
    const line = makeGLLine({ debit_amount: 100, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // The currency check must gate BOTH sides. Gating only the transaction left a
  // foreign bank amount being compared against a ledger figure that is always
  // SEK, so a same-magnitude coincidence in the wrong unit scored auto_exact.
  it('does NOT match a foreign bank row to a same-magnitude SEK ledger leg', () => {
    const tx = makeTransaction({ amount: 100, date: '2024-06-15', currency: 'EUR' })
    // A plain SEK booking: 100 kr on the same date. Same number, wrong unit.
    const sekLine = makeGLLine({
      debit_amount: 100,
      entry_date: '2024-06-15',
      currency: 'SEK',
    })

    const result = tryReconcileTransaction(tx, [sekLine], 'EUR')

    expect(result).toBeNull()
  })

  it('matches a EUR bank row against the EUR amount recorded on the ledger line', () => {
    const tx = makeTransaction({ amount: 100, date: '2024-06-15', currency: 'EUR' })
    // 100 EUR at 11.50: the ledger columns hold the 1150 SEK conversion.
    const eurLine = makeGLLine({
      debit_amount: 1150,
      entry_date: '2024-06-15',
      currency: 'EUR',
      amount_in_currency: 100,
    })

    const result = tryReconcileTransaction(tx, [eurLine], 'EUR')

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_exact')
  })

  it('still matches a SEK payment of a EUR invoice on the SEK account (label is not the unit)', () => {
    // Regression guard for the 95% path: currency-utils labels this line 'EUR'
    // while debit_amount is SEK. Reconciling 1930 in SEK must be unaffected.
    const tx = makeTransaction({ amount: 1150, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({
      debit_amount: 1150,
      entry_date: '2024-06-15',
      currency: 'EUR',
      amount_in_currency: 100,
    })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_exact')
  })

  // ------------------------------------------------------------------
  // Empty pool
  // ------------------------------------------------------------------
  it('returns null for empty GL line pool', () => {
    const tx = makeTransaction({ amount: 100, date: '2024-06-15', currency: 'SEK' })

    const result = tryReconcileTransaction(tx, [])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Priority: highest confidence wins
  // ------------------------------------------------------------------
  it('prefers exact match over date range match', () => {
    const tx = makeTransaction({ amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const exactLine = makeGLLine({
      line_id: 'exact',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })
    const rangeLine = makeGLLine({
      line_id: 'range',
      debit_amount: 1000,
      entry_date: '2024-06-14',
    })

    const result = tryReconcileTransaction(tx, [rangeLine, exactLine])

    expect(result).not.toBeNull()
    expect(result!.glLine.line_id).toBe('exact')
    expect(result!.method).toBe('auto_exact')
  })

  // ------------------------------------------------------------------
  // No double-matching when using greedy algorithm
  // ------------------------------------------------------------------
  it('each GL line can only match once in a pool', () => {
    const tx1 = makeTransaction({ id: 'tx-1', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const tx2 = makeTransaction({ id: 'tx-2', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 1000, entry_date: '2024-06-15' })

    // First transaction matches
    const result1 = tryReconcileTransaction(tx1, [line])
    expect(result1).not.toBeNull()

    // Second transaction against the same single line also matches individually
    const result2 = tryReconcileTransaction(tx2, [line])
    expect(result2).not.toBeNull()

    // But in the batch reconciliation (greedyMatch), only one would be assigned
    // This is tested in runReconciliation tests
  })
})

// ============================================================
// runReconciliation: batch matching with DB calls
// ============================================================

describe('runReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function createQueueMockSupabase(settlements: unknown[] = []) {
    const resultQueue: { data: unknown; error: unknown }[] = []

    const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
      for (const r of results) {
        resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
      }
    }

    const buildChain = (fixed?: { data: unknown; error: unknown }): unknown => {
      const handler: ProxyHandler<object> = {
        get(_target, prop) {
          if (prop === 'then') {
            const next = fixed ?? resultQueue.shift() ?? { data: null, error: null }
            return (resolve: (v: unknown) => void) => resolve(next)
          }
          return (..._args: unknown[]) => buildChain(fixed)
        },
      }
      return new Proxy({}, handler)
    }

    const supabase = {
      // The matcher reads the account's live ledger settlements before it
      // matches (crm#1074). Answered outside the queue, with `settlements`
      // (none unless a test sets them), so the queue keeps describing the
      // matcher's own reads and writes.
      from: vi.fn().mockImplementation((table: string) =>
        table === 'account_reconciliation_settlements' ? buildChain({ data: settlements, error: null }) : buildChain(),
      ),
      rpc: vi.fn().mockImplementation(() => buildChain()),
    }

    return { supabase, enqueue }
  }

  it('returns empty matches when no unmatched transactions exist', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // RPC: get_unlinked_1930_lines returns empty
    enqueue({ data: [] })
    // from('open_bank_rows').select: unmatched
    enqueue({ data: [] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1')

    expect(result.matches).toEqual([])
    expect(result.applied).toBe(0)
  })

  it('rejects when the GL lines read fails, so a sweep counts an error instead of a clean run (accounted#115)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // RPC: get_unlinked_gl_lines fails
    enqueue({ error: { message: 'canceling statement due to statement timeout', code: '57014' } })
    // from('open_bank_rows').select: one unmatched row that would otherwise read as "nothing to match"
    enqueue({ data: [makeTransaction({ id: 'tx-1', amount: 100, date: '2024-06-15', currency: 'SEK' })] })

    await expect(runReconciliation(supabase as never, 'company-1', 'user-1')).rejects.toThrow('statement timeout')
  })

  it('dry run returns matches without applying', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx = makeTransaction({ id: 'tx-1', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const glLine: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })

    // RPC returns GL lines
    enqueue({ data: [glLine] })
    // from('open_bank_rows') returns unmatched transactions
    enqueue({ data: [tx] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: true })

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].method).toBe('auto_exact')
    expect(result.applied).toBe(0)
  })

  // A pointer written on a row booked through a link would anchor it to a
  // second verifikat. The view keeps such a row out; the database decides,
  // tests/pg/bank-row-open-read.pg.test.ts proves it.
  it('matches what open_bank_rows answers, free of a pointer and with no embed', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const free = makeTransaction({ id: 'tx-free', amount: 700, date: '2024-06-15', currency: 'SEK' })

    enqueue({ data: [makeGLLine({ line_id: 'line-1', journal_entry_id: 'je-1', debit_amount: 700, entry_date: '2024-06-15' })] })
    enqueue({ data: [free] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: true })

    expect(result.candidates).toBe(1)
    expect(result.matches.map((m) => m.transaction.id)).toEqual(['tx-free'])
    expect(findCalls('open_bank_rows', 'select')).toEqual([['*']])
    expect(findCalls('open_bank_rows', 'is')).toEqual([['journal_entry_id', null]])
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('never auto-links a partially allocated verifikat, even on its full line amount', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // 1:N slices already settle 100 of the -300 line; the RPC lists it with
    // its remainder for the user. A pointer to it would count the line twice.
    const tx = makeTransaction({ id: 'tx-1', amount: -300, date: '2024-06-15', currency: 'SEK' })
    const partial: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-partial',
      credit_amount: 300,
      entry_date: '2024-06-15',
      remaining_amount: -200,
    })

    enqueue({ data: [partial] })
    enqueue({ data: [tx] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: true })

    expect(result.matches).toEqual([])
  })

  it('applies matches when not dry run', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx = makeTransaction({ id: 'tx-1', amount: -500, date: '2024-06-15', currency: 'SEK' })
    const glLine: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      credit_amount: 500,
      entry_date: '2024-06-15',
    })

    // RPC returns GL lines
    enqueue({ data: [glLine] })
    // from('open_bank_rows') returns unmatched transactions
    enqueue({ data: [tx] })
    // Update transaction with link: .select('id') returns the updated row
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: false })

    expect(result.matches).toHaveLength(1)
    expect(result.applied).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('persists the below-threshold band as suggestions when persistSuggestions is set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Fuzzy match: amount off by 1 öre on the exact date → 0.75 confidence,
    // below the 0.9 unattended floor.
    const tx = makeTransaction({ id: 'tx-1', amount: 1000.01, date: '2024-06-15', currency: 'SEK' })
    const glLine: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [glLine] }) // RPC: GL lines
    enqueue({ data: [tx] }) // transactions
    enqueue({ data: [{ id: 'tx-1' }] }) // suggestion update .select('id')

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      confidenceThreshold: 0.9,
      persistSuggestions: true,
    })

    expect(result.applied).toBe(0)
    expect(result.skippedBelowThreshold).toBe(1)
    expect(result.suggested).toBe(1)
    expect(result.candidates).toBe(1)
  })

  it('does not count a suggestion whose optimistic-lock update matched zero rows', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx = makeTransaction({ id: 'tx-1', amount: 1000.01, date: '2024-06-15', currency: 'SEK' })
    const glLine: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [glLine] })
    enqueue({ data: [tx] })
    // A concurrent writer booked the row: .is('journal_entry_id', null) → 0 rows.
    enqueue({ data: [] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      confidenceThreshold: 0.9,
      persistSuggestions: true,
    })

    expect(result.suggested).toBe(0)
    expect(result.skippedBelowThreshold).toBe(1)
  })

  it('counts a conflicted apply (0 rows updated) as an error, not applied', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx = makeTransaction({ id: 'tx-1', amount: -500, date: '2024-06-15', currency: 'SEK' })
    const glLine: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      credit_amount: 500,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [glLine] })
    enqueue({ data: [tx] })
    // Optimistic-lock guard: a concurrent linker got there first: the
    // .is('journal_entry_id', null) filter matches zero rows.
    enqueue({ data: [] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: false })

    expect(result.applied).toBe(0)
    expect(result.errors).toBe(1)
  })

  it('applies only the pairs in applyOnly, intersected with the fresh match run', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx1 = makeTransaction({ id: 'tx-1', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const tx2 = makeTransaction({ id: 'tx-2', amount: -500, date: '2024-06-15', currency: 'SEK' })
    const line1 = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })
    const line2 = makeGLLine({
      line_id: 'line-2',
      journal_entry_id: 'je-2',
      credit_amount: 500,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [line1, line2] })
    enqueue({ data: [tx1, tx2] })
    // Only ONE update should run: for the single selected pair.
    enqueue({ data: [{ id: 'tx-2' }] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      dryRun: false,
      applyOnly: [
        { transactionId: 'tx-2', journalEntryId: 'je-2' },
        // A pair the matcher never proposed must be ignored, not applied.
        { transactionId: 'tx-99', journalEntryId: 'je-99' },
      ],
    })

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].transaction.id).toBe('tx-2')
    expect(result.applied).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('skips matches below confidenceThreshold in apply mode but still reports them', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // auto_exact (0.95): above the 0.9 floor, must apply.
    const txExact = makeTransaction({ id: 'tx-exact', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const lineExact = makeGLLine({
      line_id: 'line-exact',
      journal_entry_id: 'je-exact',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })
    // auto_fuzzy (0.75): below the 0.9 floor, must be skipped, not applied.
    const txFuzzy = makeTransaction({ id: 'tx-fuzzy', amount: -999.99, date: '2024-06-15', currency: 'SEK' })
    const lineFuzzy = makeGLLine({
      line_id: 'line-fuzzy',
      journal_entry_id: 'je-fuzzy',
      credit_amount: 1000,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [lineExact, lineFuzzy] })
    enqueue({ data: [txExact, txFuzzy] })
    // Exactly ONE update runs: the exact match. If the fuzzy match were
    // applied too, the queue would be short and this enqueue insufficient.
    enqueue({ data: [{ id: 'tx-exact' }] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      dryRun: false,
      confidenceThreshold: 0.9,
    })

    // Both matches are REPORTED (skipped is not silently dropped) ...
    expect(result.matches).toHaveLength(2)
    // ... but only the high-confidence one is applied.
    expect(result.applied).toBe(1)
    expect(result.errors).toBe(0)
    expect(result.skippedBelowThreshold).toBe(1)
    const skipped = result.matches.find((m) => m.transaction.id === 'tx-fuzzy')
    expect(skipped?.method).toBe('auto_fuzzy')
  })

  it('applies a match exactly at the threshold (floor is inclusive)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // auto_date_range scores exactly 0.85: with threshold 0.85 it must apply.
    const tx = makeTransaction({ id: 'tx-1', amount: 750, date: '2024-06-17', currency: 'SEK' })
    const line = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      debit_amount: 750,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [line] })
    enqueue({ data: [tx] })
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      dryRun: false,
      confidenceThreshold: 0.85,
    })

    expect(result.applied).toBe(1)
    expect(result.skippedBelowThreshold).toBe(0)
  })

  it('dry run is unaffected by confidenceThreshold: every proposal is returned', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const txFuzzy = makeTransaction({ id: 'tx-fuzzy', amount: -999.99, date: '2024-06-15', currency: 'SEK' })
    const lineFuzzy = makeGLLine({
      line_id: 'line-fuzzy',
      journal_entry_id: 'je-fuzzy',
      credit_amount: 1000,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [lineFuzzy] })
    enqueue({ data: [txFuzzy] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      dryRun: true,
      confidenceThreshold: 0.9,
    })

    // The preview always shows the full proposal set: filtering happens only
    // on apply, so the user can still review + tick fuzzy matches manually.
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].method).toBe('auto_fuzzy')
    expect(result.applied).toBe(0)
    expect(result.skippedBelowThreshold).toBe(0)
  })

  it('applies every match, including fuzzy, when no threshold is given (legacy behavior)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const txFuzzy = makeTransaction({ id: 'tx-fuzzy', amount: -999.99, date: '2024-06-15', currency: 'SEK' })
    const lineFuzzy = makeGLLine({
      line_id: 'line-fuzzy',
      journal_entry_id: 'je-fuzzy',
      credit_amount: 1000,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [lineFuzzy] })
    enqueue({ data: [txFuzzy] })
    enqueue({ data: [{ id: 'tx-fuzzy' }] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      dryRun: false,
    })

    expect(result.applied).toBe(1)
    expect(result.errors).toBe(0)
    expect(result.skippedBelowThreshold).toBe(0)
  })

  it('ignores applyOnly on dry runs and returns the full match set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx1 = makeTransaction({ id: 'tx-1', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const line1 = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })

    enqueue({ data: [line1] })
    enqueue({ data: [tx1] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', {
      dryRun: true,
      applyOnly: [],
    })

    expect(result.matches).toHaveLength(1)
    expect(result.applied).toBe(0)
  })

  // crm#1746: the applied links teach their bank texts, as the matcher's
  // evidence, in one batch (lib/transactions/__tests__/link-learning.test.ts).
  it('hands the applied links to the learner as automatic, in one batch (crm#1746)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', amount: -500, date: '2024-06-15', currency: 'SEK' })
    enqueue({ data: [makeGLLine({ journal_entry_id: 'je-1', credit_amount: 500, entry_date: '2024-06-15' })] })
    enqueue({ data: [tx] })
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: false })

    expect(result.applied).toBe(1)
    expect(learnManySpy).toHaveBeenCalledTimes(1)
    expect(learnManySpy).toHaveBeenCalledWith(supabase, 'company-1', [{ transactionId: 'tx-1', journalEntryId: 'je-1' }], 'automatic')
  })

  it('teaches nothing from a dry run (crm#1746)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', amount: -500, date: '2024-06-15', currency: 'SEK' })
    enqueue({ data: [makeGLLine({ journal_entry_id: 'je-1', credit_amount: 500, entry_date: '2024-06-15' })] })
    enqueue({ data: [tx] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: true })

    expect(result.matches).toHaveLength(1)
    expect(learnManySpy).not.toHaveBeenCalled()
  })

})

// ============================================================
// manualLink
// ============================================================

describe('manualLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function createQueueMockSupabase() {
    const resultQueue: { data: unknown; error: unknown }[] = []
    // Every chained method call, in order, so a test can assert on the
    // payload handed to .update(...) (the #1643 re-point cases below).
    const calls: Array<{ method: string; args: unknown[] }> = []

    const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
      for (const r of results) {
        resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
      }
    }

    const buildChain = (): unknown => {
      const handler: ProxyHandler<object> = {
        get(_target, prop) {
          if (prop === 'then') {
            const next = resultQueue.shift() ?? { data: null, error: null }
            return (resolve: (v: unknown) => void) => resolve(next)
          }
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return buildChain()
          }
        },
      }
      return new Proxy({}, handler)
    }

    const supabase = {
      from: vi.fn().mockImplementation(() => buildChain()),
      rpc: vi.fn().mockImplementation(() => buildChain()),
    }

    const updatePayloads = () =>
      calls.filter((c) => c.method === 'update').map((c) => c.args[0] as Record<string, unknown>)

    return { supabase, enqueue, updatePayloads }
  }

  it('rejects when transaction not found', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Transaction query returns null
    enqueue({ data: null, error: { message: 'Not found' } })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen kunde inte hittas.')
    expect(result.code).toBe('TRANSACTION_NOT_FOUND')
  })

  it('rejects when transaction is already linked to a LIVE (posted) entry', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: 'je-existing' })

    // Transaction found, still pointing at a live posted verifikat
    enqueue({ data: tx })
    enqueue({ data: { status: 'posted' } }) // hasLiveJournalEntryLink: prior link is live

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen är redan kopplad till en verifikation.')
    expect(result.code).toBe('TRANSACTION_ALREADY_LINKED')
  })

  it('refuses an ignored transaction by name before any write (the CHECK constraint used to answer "Försök igen")', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: makeTransaction({ id: 'tx-1', journal_entry_id: null, is_ignored: true }) })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result).toEqual({
      success: false,
      error: 'Transaktionen är ignorerad. Återställ den innan du kopplar.',
      code: 'TRANSACTION_IGNORED',
    })
    // Nothing past the transaction read: no verifikat lookup, no write.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('tells a missing verifikat, a reversed one and a draft apart', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    let m = createQueueMockSupabase()
    m.enqueue({ data: tx })
    m.enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    let result = await manualLink(m.supabase as never, 'company-1', 'tx-1', 'je-typo', 'user-1', '1930', MANUAL)
    expect(result).toMatchObject({ success: false, code: 'ENTRY_NOT_FOUND', error: 'Verifikationen kunde inte hittas.' })

    m = createQueueMockSupabase()
    m.enqueue({ data: tx })
    m.enqueue({ data: { id: 'je-1', status: 'reversed' } })
    result = await manualLink(m.supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)
    expect(result).toMatchObject({ success: false, code: 'ENTRY_REVERSED', error: 'Verifikationen är makulerad och kan inte kopplas.' })

    m = createQueueMockSupabase()
    m.enqueue({ data: tx })
    m.enqueue({ data: { id: 'je-1', status: 'draft' } })
    result = await manualLink(m.supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)
    expect(result).toMatchObject({ success: false, code: 'ENTRY_NOT_POSTED', error: 'Verifikationen är inte bokförd ännu.' })
  })

  it('re-links a transaction stranded on a reversed entry (#988)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    // Still carries a pointer at a status='reversed' entry (storno/correction
    // left it behind). The UI shows it as "utan koppling", so manualLink must
    // treat it as free and overwrite the stale pointer.
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: 'je-reversed' })

    enqueue({ data: tx }) // tx fetch
    enqueue({ data: { status: 'reversed' } }) // hasLiveJournalEntryLink: stale link
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } }) // target JE fetch
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] }) // line on 1930
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] }) // UPDATE .eq(stale id) → 1 row overwritten

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
  })

  it('rejects when journal entry has no line on the selected account', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    // Transaction found (cash_account_id null → cross-check skipped)
    enqueue({ data: tx })
    // Journal entry found
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // No line on the selected account
    enqueue({ data: [] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Verifikationen saknar rad på 1930')
    expect(result.code).toBe('NOT_SETTLED')
  })

  it('rejects when the transaction belongs to a different cash account', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      cash_account_id: 'ca-1931',
    })

    // Transaction found (bound to a cash account)
    enqueue({ data: tx })
    // Journal entry found + posted
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // Cross-check: this cash account maps to 1931, but we're reconciling 1930
    enqueue({ data: { ledger_account: '1931' } })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen hör till 1931, inte 1930')
    expect(result.code).toBe('TRANSACTION_OTHER_ACCOUNT')
  })

  it('succeeds when all validations pass (line on selected account)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    // Transaction found (cash_account_id null → cross-check skipped)
    enqueue({ data: tx })
    // Journal entry found
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // Line exists on the selected account
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    // Update succeeds: .select('id') returns the updated row
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
  })

  it("anchors the row's underlag (its pin, its matched inkorg items) to the verifikat a person or an agent chose", async () => {
    // crm#1101: a document pinned in a booking dialog whose duplicate guard
    // ended in "Matcha mot verifikatet" stayed off the existing verifikat.
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: makeTransaction({ id: 'tx-1', journal_entry_id: null }) })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', {
      anchorUnderlag: true,
      linkBasis: { basis: 'user_confirmed' },
    })

    expect(result.success).toBe(true)
    expect(propagateUnderlag).toHaveBeenCalledTimes(1)
    expect(propagateUnderlag).toHaveBeenCalledWith(supabase, 'company-1', 'tx-1', 'je-1')
  })

  it("leaves the row's underlag on the row unless the caller asks: an anchor outlives Koppla bort", async () => {
    // The auto-link after an invoice is linked to its voucher, a confirmed
    // suggestion and bulk-applied proposals call without the option: a
    // guessed link must not make the row's receipt that verifikat's
    // underlag for good.
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: makeTransaction({ id: 'tx-1', journal_entry_id: null }) })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
    expect(propagateUnderlag).not.toHaveBeenCalled()
  })

  it('anchors nothing when the link did not happen', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: makeTransaction({ id: 'tx-1', journal_entry_id: null }) })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    // A concurrent linker won: the optimistic-lock UPDATE matched nothing.
    enqueue({ data: [] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', {
      anchorUnderlag: true,
      linkBasis: { basis: 'user_confirmed' },
    })

    expect(result.code).toBe('LINK_RACE')
    expect(propagateUnderlag).not.toHaveBeenCalled()
  })

  it('refuses a row anchored through a bank_line junction row (bulk-book, 1:N split) even with a NULL pointer', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = {
      ...makeTransaction({ id: 'tx-1', journal_entry_id: null }),
      transaction_voucher_links: [{ journal_entry_id: 'je-split-a', role: 'bank_line' }],
    }
    enqueue({ data: tx })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen är redan kopplad till en verifikation.')
    expect(result.code).toBe('TRANSACTION_ALREADY_LINKED')
    // Nothing past the transaction read: no verifikat lookup, no write.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('does not treat a residual booking\'s "other" junction row as a link (the row stays re-linkable after a storno)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = {
      ...makeTransaction({ id: 'tx-1', journal_entry_id: null }),
      transaction_voucher_links: [{ journal_entry_id: 'je-residual', role: 'other' }],
    }
    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
  })

  it('rejects when a concurrent linker won the race (0 rows updated)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    // The .is('journal_entry_id', null) optimistic-lock filter matched nothing:
    // another session linked the transaction between our read and this write.
    enqueue({ data: [] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen är redan kopplad till en verifikation.')
    expect(result.code).toBe('LINK_RACE')
  })

  it('names a link the bank-anchor guard refused at the write (a verifikat changed since the read) instead of "Försök igen"', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: null, error: { code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' } })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.code).toBe('BANK_ANCHOR_REFUSED')
    expect(result.error).toMatch(/^Kopplingen nekades/)
  })

  it('keeps WRITE_FAILED for any other write error', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result).toEqual({
      success: false,
      error: 'Kunde inte koppla transaktionen. Försök igen.',
      code: 'WRITE_FAILED',
    })
  })

  it('succeeds for a bound transaction when the account matches', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      cash_account_id: 'ca-1930',
    })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // Cross-check: cash account maps to the account being reconciled
    enqueue({ data: { ledger_account: '1930' } })
    // Sibling-ledger scan (#1643): a row without an IBAN has no siblings.
    enqueue({ data: [{ id: 'ca-1930', iban: null, ledger_account: '1930', currency: 'SEK', enabled: true, bank_connection_id: null }] })
    // Line exists on 1930
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    // Update succeeds: .select('id') returns the updated row
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
  })

  it('links a transaction stranded on an orphaned row to a voucher on the live sibling ledger and re-points it there (#1643)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    // Transaction stamped on the orphaned reconnect row (ledger 1931); the
    // verifikat it settles is booked on the live ledger 1940 of the SAME
    // physical account (same IBAN).
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      cash_account_id: 'ca-orphan',
      currency: 'SEK',
    })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // Cross-check: the transaction's own ledger IS the requested account.
    enqueue({ data: { ledger_account: '1931' } })
    // Sibling scan: the own (demoted) row carries the IBAN and the live row
    // shares it on 1940.
    enqueue({
      data: [
        { id: 'ca-orphan', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: null },
        { id: 'ca-live', iban, ledger_account: '1940', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    // The voucher's bank leg sits on the sibling ledger, not on 1931.
    enqueue({ data: [{ debit_amount: 0, credit_amount: 217.04, account_number: '1940' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1931', MANUAL)

    expect(result.success).toBe(true)
    // The same locked UPDATE that stamps the link moves the row to the live
    // sibling row, so neither account's reconciliation counts a cross-account
    // link as an imbalance.
    expect(updatePayloads()).toEqual([
      expect.objectContaining({ journal_entry_id: 'je-1', cash_account_id: 'ca-live' }),
    ])
  })

  it('does not re-point when the voucher line is on the transaction\'s own ledger (#1643)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null, cash_account_id: 'ca-orphan' })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1931' } })
    enqueue({
      data: [
        { id: 'ca-orphan', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: null },
        { id: 'ca-live', iban, ledger_account: '1940', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    // Bank leg on 1931 itself: an ordinary same-ledger link.
    enqueue({ data: [{ debit_amount: 0, credit_amount: 217.04, account_number: '1931' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1931', MANUAL)

    expect(result.success).toBe(true)
    expect(updatePayloads()[0]).not.toHaveProperty('cash_account_id')
  })

  it('rejects a voucher whose only bank line is on another-currency pocket of the same IBAN (#1643)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      cash_account_id: 'ca-sek',
      currency: 'SEK',
    })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1931' } })
    // Multi-currency account: the EUR pocket shares the IBAN but is another
    // account, so it is not a sibling and the line check stays on 1931.
    enqueue({
      data: [
        { id: 'ca-sek', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
        { id: 'ca-eur', iban, ledger_account: '1932', currency: 'EUR', enabled: true, bank_connection_id: 'conn-live' },
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    enqueue({ data: [] }) // no line on 1931 (the voucher only has a 1932 leg)

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1931', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Verifikationen saknar rad på 1931')
    expect(updatePayloads()).toEqual([])
  })

  it('refuses a voucher that sits only on a sibling that is NOT the live row (#1643 round 4)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    // Reverse direction: the transaction synced onto the live 1940 row, the
    // voucher was booked on the now-revoked 1931 before the reconnect. The
    // voucher is what is wrong; the row must not be parked on the dead row,
    // and a cross-account link (money on 1940, voucher on 1931) would show
    // as an imbalance on both ledgers, so the link is refused outright.
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      cash_account_id: 'ca-live',
      currency: 'SEK',
    })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1940' } })
    enqueue({
      data: [
        { id: 'ca-live', iban, ledger_account: '1940', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
        { id: 'ca-orphan', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: 'conn-old' },
      ],
    })
    enqueue({
      data: [
        { id: 'conn-live', status: 'active' },
        { id: 'conn-old', status: 'revoked' },
      ],
    })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1931' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1940', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'Verifikationen är bokförd på 1931, som inte är transaktionens konto (1940). Rätta verifikationen eller flytta transaktionen först.',
    )
    expect(updatePayloads()).toEqual([])
  })

  it('refuses to link an EXPIRED own row to a voucher only on a demoted twin (renewable consent, #1643 rounds 3-4)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    // Prod shape: 1930 on an expired connection (still the syncing account,
    // re-auth renews it in place) beside a demoted manual twin 1931. Moving
    // the row onto 1931 would strand it on the orphan once consent is renewed.
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null, cash_account_id: 'ca-expired', currency: 'SEK' })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({
      data: [
        { id: 'ca-expired', iban, ledger_account: '1930', currency: 'SEK', enabled: true, bank_connection_id: 'conn-expired' },
        { id: 'ca-demoted', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: null },
      ],
    })
    enqueue({ data: [{ id: 'conn-expired', status: 'expired' }] })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1931' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toContain('bokförd på 1931')
    expect(updatePayloads()).toEqual([])
  })

  it('re-points to the LIVE sibling when the voucher touches a dead twin and the live twin, whatever the line order (#1643 round 4)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    // An old cross-ledger "transfer" between two rows of one physical
    // account: lines on the revoked 1931 and the live 1940, none on the
    // demoted 1930 the transaction sits on. The query has no ORDER BY, so
    // the dead line comes first here; the destination must still be 1940.
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null, cash_account_id: 'ca-1930', currency: 'SEK' })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({
      data: [
        { id: 'ca-1930', iban, ledger_account: '1930', currency: 'SEK', enabled: true, bank_connection_id: null },
        { id: 'ca-1931', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: 'conn-old' },
        { id: 'ca-1940', iban, ledger_account: '1940', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
      ],
    })
    enqueue({
      data: [
        { id: 'conn-old', status: 'revoked' },
        { id: 'conn-live', status: 'active' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 1000, credit_amount: 0, account_number: '1931' },
        { debit_amount: 0, credit_amount: 1000, account_number: '1940' },
      ],
    })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
    expect(updatePayloads()).toEqual([
      expect.objectContaining({ journal_entry_id: 'je-1', cash_account_id: 'ca-1940' }),
    ])
  })

  it('re-points to the sibling the voucher was booked on when BOTH rows are live (#1643 round 2)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    // 1930 and 1931 both enabled on one active connection (the common prod
    // shape): the voucher settled on 1931, the transaction sits on 1930. A
    // cross-account link would show a difference on both ledgers.
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null, cash_account_id: 'ca-1930', currency: 'SEK' })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({
      data: [
        { id: 'ca-1930', iban, ledger_account: '1930', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
        { id: 'ca-1931', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1931' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
    expect(updatePayloads()).toEqual([
      expect.objectContaining({ journal_entry_id: 'je-1', cash_account_id: 'ca-1931' }),
    ])
  })

  it('re-points to the sibling the voucher was booked on when NEITHER row is live (#1643 round 2)', async () => {
    const { supabase, enqueue, updatePayloads } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    // Full disconnect: both rows demoted to manual, IBAN kept. The voucher is
    // the source of truth for where the money was booked.
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null, cash_account_id: 'ca-1931', currency: 'SEK' })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1931' } })
    enqueue({
      data: [
        { id: 'ca-1931', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: null },
        { id: 'ca-1940', iban, ledger_account: '1940', currency: 'SEK', enabled: true, bank_connection_id: null },
      ],
    })
    // No bank_connection ids: the status lookup is skipped.
    enqueue({ data: [{ debit_amount: 0, credit_amount: 217.04, account_number: '1940' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat (#3507)
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1931', MANUAL)

    expect(result.success).toBe(true)
    expect(updatePayloads()).toEqual([
      expect.objectContaining({ journal_entry_id: 'je-1', cash_account_id: 'ca-1940' }),
    ])
  })

  it('still rejects a voucher with no line on the account or any sibling ledger', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const iban = 'SE4550000000058398257466'
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      cash_account_id: 'ca-orphan',
    })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: { ledger_account: '1931' } })
    enqueue({
      data: [
        { id: 'ca-orphan', iban, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: null },
        { id: 'ca-live', iban, ledger_account: '1940', currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
      ],
    })
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] })
    enqueue({ data: [] }) // no line on 1931 OR 1940

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1931', MANUAL)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Verifikationen saknar rad på 1931 eller 1940')
  })

  it('allows N:1 within the bank leg: a row that fits in what the linked rows leave links', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    // The TARGET entry already has another transaction pointing at it, for
    // 600 of its 1000. Several bank transactions may settle one verifikat (a
    // salary run paid in multiple transfers) as long as they fit in it
    // (GitHub #3507); THIS transaction must not be linked itself either.
    const tx = makeTransaction({ id: 'tx-2', journal_entry_id: null, amount: 400 })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 1000, credit_amount: 0, account_number: '1930' }] })
    enqueue({ data: [] }) // bank_line slices
    enqueue({ data: [{ id: 'tx-1', journal_entry_id: 'je-1', amount: 600, currency: 'SEK', cash_account_id: null }] })
    enqueue({ data: [{ id: 'tx-2' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-2', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.success).toBe(true)
  })

  // crm#1746: a link teaches its bank text. The learner is tested in
  // lib/transactions/__tests__/link-learning.test.ts; here which evidence
  // manualLink hands it, and that the link stands whatever it answers.
  function enqueueLinkThatLands(enqueue: (...results: { data?: unknown; error?: unknown }[]) => void) {
    enqueue({ data: makeTransaction({ id: 'tx-1', journal_entry_id: null }) })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 0, credit_amount: 1000, account_number: '1930' }] })
    enqueue({ data: [] }, { data: [] }) // bank_line slices, pointers: nobody else holds the verifikat
    enqueue({ data: [{ id: 'tx-1' }] })
  }

  it('teaches the bank text at once from a pair the caller chose (crm#1746)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueueLinkThatLands(enqueue)
    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', {
      anchorUnderlag: true,
      linkBasis: { basis: 'user_confirmed' },
    })
    expect(result.success).toBe(true)
    expect(learnSpy).toHaveBeenCalledWith(supabase, 'company-1', { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')
  })

  it('waits for a repetition on a pair the system guessed: a confirmed suggestion, the invoice auto-link (crm#1746)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueueLinkThatLands(enqueue)
    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', {
      linkBasis: { basis: 'rule_amount_date' },
    })
    expect(result.success).toBe(true)
    expect(learnSpy).toHaveBeenCalledWith(supabase, 'company-1', { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')
  })

  it('leaves the link standing when learning fails (crm#1746)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueueLinkThatLands(enqueue)
    enqueue({ error: { message: 'statement timeout' } }) // the learner's first read
    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', {
      anchorUnderlag: true,
      linkBasis: { basis: 'user_confirmed' },
    })
    expect(result).toEqual({ success: true })
    expect(await learnSpy.mock.results[0].value).toEqual({ outcome: 'failed' })
  })

  it('teaches nothing when the link did not happen (crm#1746)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: null, error: { message: 'Not found' } })
    await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930', MANUAL)
    expect(learnSpy).not.toHaveBeenCalled()
  })

})

// ============================================================
// manualLink: room on the verifikat's bank leg (GitHub #3507)
// ============================================================

describe('manualLink: the verifikat must have room for the row on its bank leg (#3507)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  const CASH = 'ca-1930'
  const pointer = (id: string, amount: number, over: Record<string, unknown> = {}) => ({
    id,
    journal_entry_id: 'je-1',
    amount,
    currency: 'SEK',
    cash_account_id: CASH,
    ...over,
  })

  /**
   * Queue a row bound to 1930 up to the room check: the row, the verifikat,
   * the cash-account cross-check, the sibling scan, the verifikat's lines,
   * then the two holder reads (bank_line slices, pointers).
   */
  function enqueueLink(
    enqueue: (r: { data?: unknown; error?: unknown }) => void,
    opts: { amount: number; currency?: 'SEK' | 'EUR'; lines: unknown[]; slices?: unknown[]; pointers?: unknown[] },
  ) {
    enqueue({
      data: makeTransaction({
        id: 'tx-b',
        journal_entry_id: null,
        cash_account_id: CASH,
        amount: opts.amount,
        currency: opts.currency ?? 'SEK',
      }),
    })
    enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 17, entry_date: '2026-10-05' } })
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({ data: [{ id: CASH, iban: null, ledger_account: '1930', currency: opts.currency ?? 'SEK', enabled: true, bank_connection_id: null }] })
    enqueue({ data: opts.lines })
    enqueue({ data: opts.slices ?? [] })
    enqueue({ data: opts.pointers ?? [] })
  }

  const sale = [{ debit_amount: 2800, credit_amount: 0, account_number: '1930', currency: null, amount_in_currency: null }]

  it('refuses a second payment of the same amount on a verifikat a first one already settles in full (the reported shape)', async () => {
    const m = createQueuedMockSupabase()
    enqueueLink(m.enqueue, { amount: 2800, lines: sale, pointers: [pointer('tx-a', 2800)] })

    const result = await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)

    expect(result).toMatchObject({ success: false, code: 'VOUCHER_BANK_LEG_CONSUMED' })
    expect(result.error).toContain('Verifikat A17 bokför 2800 på 1930')
    expect(result.error).toContain('bokför den som ett eget verifikat')
    expect(m.findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a payout on a verifikat that books nothing in kredit on the account, before the write, naming the way through (crm#1583)', async () => {
    const m = createQueuedMockSupabase()
    enqueueLink(m.enqueue, { amount: -64.5, lines: sale })

    const result = await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)

    expect(result).toMatchObject({ success: false, code: 'BANK_ANCHOR_REFUSED' })
    expect(result.error).toContain('Verifikat A17 bokför inget uttag (kredit) på 1930')
    expect(m.findCalls('transactions', 'update')).toEqual([])
  })

  it('counts a bank_line slice (a bulk-booked samlingsverifikat) like a pointer', async () => {
    const m = createQueuedMockSupabase()
    enqueueLink(m.enqueue, {
      amount: 2800,
      lines: sale,
      slices: [{ transaction_id: 'tx-a', journal_entry_id: 'je-1', allocated_amount: 2800, transactions: { amount: 2800, currency: 'SEK', cash_account_id: CASH } }],
    })

    const result = await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.code).toBe('VOUCHER_BANK_LEG_CONSUMED')
    expect(m.findCalls('transactions', 'update')).toEqual([])
  })

  it.each([
    ['the first instalment', [], true],
    ['the second instalment', [pointer('tx-1', -1400)], true],
    ['a third instalment the verifikat no longer has room for', [pointer('tx-1', -1400), pointer('tx-2', -1400)], false],
  ])('instalments: %s of 1 400 against one 2 800 payout', async (_name, pointers, links) => {
    const m = createQueuedMockSupabase()
    enqueueLink(m.enqueue, {
      amount: -1400,
      lines: [{ debit_amount: 0, credit_amount: 2800, account_number: '1930', currency: null, amount_in_currency: null }],
      pointers,
    })
    m.enqueue({ data: [{ id: 'tx-b' }] }) // the locked UPDATE

    const result = await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)

    if (links) {
      expect(result).toEqual({ success: true })
    } else {
      expect(result.code).toBe('VOUCHER_BANK_LEG_CONSUMED')
      expect(m.findCalls('transactions', 'update')).toEqual([])
    }
  })

  it('is sign-aware: a deposit never takes the room a payout leaves, nor the other way round', async () => {
    // One verifikat moves 1930 both ways: in 2 800, out 500. The deposit side
    // is taken; the payout side is free.
    const both = [
      { debit_amount: 2800, credit_amount: 0, account_number: '1930', currency: null, amount_in_currency: null },
      { debit_amount: 0, credit_amount: 500, account_number: '1930', currency: null, amount_in_currency: null },
    ]
    const deposit = createQueuedMockSupabase()
    enqueueLink(deposit.enqueue, { amount: 100, lines: both, pointers: [pointer('tx-a', 2800)] })
    expect(
      (await manualLink(deposit.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).code,
    ).toBe('VOUCHER_BANK_LEG_CONSUMED')

    const payout = createQueuedMockSupabase()
    enqueueLink(payout.enqueue, { amount: -500, lines: both, pointers: [pointer('tx-a', 2800)] })
    payout.enqueue({ data: [{ id: 'tx-b' }] })
    expect(await manualLink(payout.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).toEqual({
      success: true,
    })
  })

  it('takes the rows of a verifikat that moves the account both ways in any order', async () => {
    // Without per-direction room the 3 000 row, linked after the -200 one,
    // would not fit in the 2 800 net.
    const both = [
      { debit_amount: 3000, credit_amount: 0, account_number: '1930', currency: null, amount_in_currency: null },
      { debit_amount: 0, credit_amount: 200, account_number: '1930', currency: null, amount_in_currency: null },
    ]
    const m = createQueuedMockSupabase()
    enqueueLink(m.enqueue, { amount: 3000, lines: both, pointers: [pointer('tx-a', -200)] })
    m.enqueue({ data: [{ id: 'tx-b' }] })

    expect(await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).toEqual({
      success: true,
    })
  })

  it('does not count the other leg of an own-account transfer, held by a row on another cash account', async () => {
    const m = createQueuedMockSupabase()
    enqueueLink(m.enqueue, { amount: 2800, lines: sale, pointers: [pointer('tx-a', 2800, { cash_account_id: 'ca-1940' })] })
    m.enqueue({ data: [{ id: 'tx-b' }] })

    expect(await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).toEqual({
      success: true,
    })
  })

  it('measures a foreign account in its own currency (amount_in_currency), never the SEK figure', async () => {
    // 1 000 EUR booked at 11.50: the SEK column says 11 500. Another EUR row
    // already holds the 1 000 EUR.
    const eurLine = [{ debit_amount: 11500, credit_amount: 0, account_number: '1930', currency: 'EUR', amount_in_currency: 1000 }]
    const taken = createQueuedMockSupabase()
    enqueueLink(taken.enqueue, {
      amount: 1000,
      currency: 'EUR',
      lines: eurLine,
      pointers: [pointer('tx-a', 1000, { currency: 'EUR' })],
    })
    expect(
      (await manualLink(taken.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).code,
    ).toBe('VOUCHER_BANK_LEG_CONSUMED')

    // Half of it held: the other 500 EUR still fits.
    const half = createQueuedMockSupabase()
    enqueueLink(half.enqueue, {
      amount: 500,
      currency: 'EUR',
      lines: eurLine,
      pointers: [pointer('tx-a', 500, { currency: 'EUR' })],
    })
    half.enqueue({ data: [{ id: 'tx-b' }] })
    expect(await manualLink(half.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).toEqual({
      success: true,
    })
  })

  it('takes the first row of a verifikat it cannot measure in the row currency, and refuses a second one', async () => {
    // An EUR line with no amount_in_currency (a SIE import): no room to compute.
    const unmeasurable = [{ debit_amount: 11500, credit_amount: 0, account_number: '1930', currency: null, amount_in_currency: null }]
    const first = createQueuedMockSupabase()
    enqueueLink(first.enqueue, { amount: 1000, currency: 'EUR', lines: unmeasurable })
    first.enqueue({ data: [{ id: 'tx-b' }] })
    expect(await manualLink(first.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).toEqual({
      success: true,
    })

    const second = createQueuedMockSupabase()
    enqueueLink(second.enqueue, {
      amount: 1000,
      currency: 'EUR',
      lines: unmeasurable,
      pointers: [pointer('tx-a', 1000, { currency: 'EUR' })],
    })
    expect(
      (await manualLink(second.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).code,
    ).toBe('VOUCHER_BANK_LEG_CONSUMED')
  })

  it('lets a residual booked in the same act take the rows past the verifikat (bankLegOverrun)', async () => {
    // Booked 2 000 in, 1 000 already held by an instalment; the second
    // instalment arrived as 1 005: 5 kr interest booked right after.
    const lines = [{ debit_amount: 2000, credit_amount: 0, account_number: '1930', currency: null, amount_in_currency: null }]
    const without = createQueuedMockSupabase()
    enqueueLink(without.enqueue, { amount: 1005, lines, pointers: [pointer('tx-a', 1000)] })
    expect(
      (await manualLink(without.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).code,
    ).toBe('VOUCHER_BANK_LEG_CONSUMED')

    const withResidual = createQueuedMockSupabase()
    enqueueLink(withResidual.enqueue, { amount: 1005, lines, pointers: [pointer('tx-a', 1000)] })
    withResidual.enqueue({ data: [{ id: 'tx-b' }] })
    expect(
      await manualLink(withResidual.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', {
        ...MANUAL,
        bankLegOverrun: 5,
      }),
    ).toEqual({ success: true })
  })

  it('keeps the matcher\'s one-öre fuzzy band: a row 0.01 above the verifikat still links', async () => {
    const m = createQueuedMockSupabase()
    enqueueLink(m.enqueue, { amount: 2800.01, lines: sale })
    m.enqueue({ data: [{ id: 'tx-b' }] })

    expect(await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)).toEqual({
      success: true,
    })
  })

  it('does not link when the holders cannot be read', async () => {
    const m = createQueuedMockSupabase()
    m.enqueue({ data: makeTransaction({ id: 'tx-b', journal_entry_id: null, cash_account_id: CASH, amount: 2800 }) })
    m.enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 17, entry_date: '2026-10-05' } })
    m.enqueue({ data: { ledger_account: '1930' } })
    m.enqueue({ data: [{ id: CASH, iban: null, ledger_account: '1930', currency: 'SEK', enabled: true, bank_connection_id: null }] })
    m.enqueue({ data: sale })
    m.enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) // bank_line slices

    const result = await manualLink(m.supabase as never, 'company-1', 'tx-b', 'je-1', 'user-1', '1930', MANUAL)

    expect(result.code).toBe('WRITE_FAILED')
    expect(m.findCalls('transactions', 'update')).toEqual([])
  })
})

// ============================================================
// linkTransactionToVouchers: ONE bank row over SEVERAL verifikat (1:N, #1553)
// ============================================================

describe('linkTransactionToVouchers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  const E1 = 'je-utlagg-1'
  const E2 = 'je-utlagg-2'
  const postedEntries = [
    { id: E1, status: 'posted', voucher_series: 'A', voucher_number: 11 },
    { id: E2, status: 'posted', voucher_series: 'A', voucher_number: 12 },
  ]
  /** Two utlägg verifikat, each crediting 1930: -500 and -300 in bank terms. */
  const bankLines = [
    { journal_entry_id: E1, debit_amount: 0, credit_amount: 500, currency: null, amount_in_currency: null },
    { journal_entry_id: E2, debit_amount: 0, credit_amount: 300, currency: null, amount_in_currency: null },
  ]
  const freeTx = (over: Record<string, unknown> = {}) => ({
    ...makeTransaction({ id: 'tx-1', amount: -800, journal_entry_id: null, reconciliation_method: null }),
    transaction_voucher_links: [],
    ...over,
  })

  /**
   * Queue up to and including the ledger reads, in the order the function
   * consumes them: tx, invoice_payments, supplier_invoice_payments,
   * journal_entries, journal_entry_lines, and the bank_line slices other rows
   * already hold on the verifikat. (cash_account_id is null on the fixture,
   * so the cash-account cross-check is skipped.)
   */
  function enqueueReads(
    enqueue: (r: { data?: unknown; error?: unknown }) => void,
    opts: { tx?: Record<string, unknown>; entries?: unknown[]; lines?: unknown[]; held?: unknown[]; pointers?: unknown[] } = {},
  ) {
    enqueue({ data: opts.tx ?? freeTx() })
    enqueue({ data: [] }) // invoice_payments
    enqueue({ data: [] }) // supplier_invoice_payments
    enqueue({ data: opts.entries ?? postedEntries })
    enqueue({ data: opts.lines ?? bankLines })
    enqueue({ data: opts.held ?? [] }) // transaction_voucher_links held by other rows
    enqueue({ data: opts.pointers ?? [] }) // other rows whose pointer names a verifikat (GitHub #3507)
  }

  it.each(['opening_balance', 'storno'])('refuses a %s as a slice: it is no bank movement', async (sourceType) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, { entries: [postedEntries[0], { ...postedEntries[1], source_type: sourceType }] })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
    )

    expect(result).toMatchObject({ success: false, code: 'ENTRY_NOT_BANK_MOVEMENT' })
  })

  it('links one row to two verifikat: pointer stays NULL, one signed bank_line slice per verifikat, one matched event each', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const reconciled = vi.fn()
    eventBus.on('transaction.reconciled', reconciled)
    enqueueReads(enqueue)
    enqueue({ data: [{ id: 'tx-1' }] }) // lock UPDATE
    enqueue({ data: null }) // junction insert
    enqueue({ data: null }) // payment_match_log

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [
        { journal_entry_id: E1, amount: -500 },
        { journal_entry_id: E2, amount: -300 },
      ],
      'user-1',
      '1930',
    )

    expect(result).toEqual({
      success: true,
      allocations: [
        { journal_entry_id: E1, amount: -500 },
        { journal_entry_id: E2, amount: -300 },
      ],
    })
    // The lock: pointer explicitly NULL, method manual, business, locked on
    // the pointer being NULL (a concurrent linker makes it match zero rows).
    const [lockPayload] = findCalls('transactions', 'update')[0]
    expect(lockPayload).toEqual({
      journal_entry_id: null,
      reconciliation_method: 'manual',
      is_business: true,
      potential_journal_entry_id: null,
      potential_match_method: null,
      potential_match_confidence: null,
    })
    expect(findCalls('transactions', 'is')[0]).toEqual(['journal_entry_id', null])
    // One insert carrying both slices.
    const inserts = findCalls('transaction_voucher_links', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toEqual([
      // A split is named slice by slice: user_confirmed on every slice.
      { user_id: 'user-1', company_id: 'company-1', transaction_id: 'tx-1', journal_entry_id: E1, allocated_amount: -500, role: 'bank_line', link_basis: 'user_confirmed', link_evidence: null },
      { user_id: 'user-1', company_id: 'company-1', transaction_id: 'tx-1', journal_entry_id: E2, allocated_amount: -300, role: 'bank_line', link_basis: 'user_confirmed', link_evidence: null },
    ])
    // Behandlingshistorik row with every slice.
    const [logRow] = findCalls('payment_match_log', 'insert')[0] as [Record<string, unknown>]
    expect(logRow).toMatchObject({ user_id: 'user-1', transaction_id: 'tx-1', action: 'matched', match_method: 'manual' })
    expect((logRow.new_state as { journal_entry_ids: string[] }).journal_entry_ids).toEqual([E1, E2])
    expect(reconciled).toHaveBeenCalledTimes(2)
    // Handlers receive the payload itself (lib/events/bus.ts).
    expect(reconciled.mock.calls.map((c) => c[0].journalEntryId)).toEqual([E1, E2])
  })

  it('defaults an omitted slice to the verifikat\'s net line on the account', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueue({ data: [{ id: 'tx-1' }] })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result.success).toBe(true)
    expect(result.allocations).toEqual([
      { journal_entry_id: E1, amount: -500 },
      { journal_entry_id: E2, amount: -300 },
    ])
    expect(findCalls('transaction_voucher_links', 'insert')).toHaveLength(1)
  })

  it('dry run validates and resolves the slices without writing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue)

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
      { dryRun: true },
    )

    expect(result.success).toBe(true)
    expect(result.allocations).toHaveLength(2)
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('transaction_voucher_links', 'insert')).toEqual([])
  })

  it('refuses when the slices do not sum to the transaction amount, writing nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue, { tx: freeTx({ amount: -900 }) })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('Fördelningen (-800) stämmer inte med transaktionens belopp (-900).')
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('transaction_voucher_links', 'insert')).toEqual([])
  })

  it('refuses a slice with the wrong sign for the verifikat\'s bank line', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue)

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [
        { journal_entry_id: E1, amount: 500 },
        { journal_entry_id: E2, amount: -1300 },
      ],
      'user-1',
      '1930',
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('Beloppet för verifikat A11 har fel riktning: verifikatet bokför -500 på 1930.')
  })

  it('refuses a slice larger than the verifikat\'s bank line', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, { tx: freeTx({ amount: -1000 }) })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [
        { journal_entry_id: E1, amount: -700 },
        { journal_entry_id: E2, amount: -300 },
      ],
      'user-1',
      '1930',
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('Beloppet för verifikat A11 (-700) är större än verifikatets rad på 1930 (-500).')
  })

  it('refuses a zero slice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue)

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [
        { journal_entry_id: E1, amount: 0 },
        { journal_entry_id: E2, amount: -800 },
      ],
      'user-1',
      '1930',
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('Beloppet för verifikat A11 får inte vara 0.')
  })

  it('refuses fewer than two verifikat, and the same verifikat twice, before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()

    const one = await linkTransactionToVouchers(supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }], 'user-1')
    expect(one).toEqual({ success: false, error: 'En delning kräver minst två verifikat.', code: 'INVALID_SPLIT' })

    const dup = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E1 }],
      'user-1',
    )
    expect(dup).toEqual({
      success: false,
      error: 'Samma verifikat förekommer flera gånger i fördelningen.',
      code: 'INVALID_SPLIT',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a split over more than MAX_BANK_ROW_SPLIT verifikat before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    const tooMany = Array.from({ length: MAX_BANK_ROW_SPLIT + 1 }, (_, i) => ({ journal_entry_id: `je-${i}` }))

    const result = await linkTransactionToVouchers(supabase as never, 'company-1', 'tx-1', tooMany, 'user-1')

    expect(result).toEqual({
      success: false,
      error: `En delning kan omfatta högst ${MAX_BANK_ROW_SPLIT} verifikat.`,
      code: 'INVALID_SPLIT',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('links a ROT/RUT payout of 138 verifikat, reading them in slices that keep each URL short (crm#1144)', async () => {
    // One Skatteverket payout row, one payment verifikat per invoice: 138 x 500 kr.
    const ids = Array.from({ length: 138 }, (_, i) => `je-rut-${i}`)
    const entries = ids.map((id, i) => ({ id, status: 'posted', voucher_series: 'A', voucher_number: 100 + i }))
    const lines = ids.map((id) => ({
      journal_entry_id: id,
      debit_amount: 500,
      credit_amount: 0,
      currency: null,
      amount_in_currency: null,
    }))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: freeTx({ amount: 69000 }) })
    enqueue({ data: [] }) // invoice_payments
    enqueue({ data: [] }) // supplier_invoice_payments
    enqueue({ data: entries.slice(0, ID_READ_CHUNK) })
    enqueue({ data: entries.slice(ID_READ_CHUNK) })
    enqueue({ data: lines.slice(0, ID_READ_CHUNK) })
    enqueue({ data: lines.slice(ID_READ_CHUNK) })
    enqueue({ data: [] }) // bank_line slices held by other rows, first slice
    enqueue({ data: [] }) // pointers, first slice
    enqueue({ data: [] }) // bank_line slices, second slice
    enqueue({ data: [] }) // pointers, second slice
    enqueue({ data: [{ id: 'tx-1' }] }) // lock UPDATE
    enqueue({ data: null }) // junction insert
    enqueue({ data: null }) // payment_match_log

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      ids.map((id) => ({ journal_entry_id: id })),
      'user-1',
      '1930',
    )

    expect(result.success).toBe(true)
    expect(result.allocations).toHaveLength(138)
    expect(result.allocations?.every((a) => a.amount === 500)).toBe(true)
    for (const table of ['journal_entries', 'journal_entry_lines', 'transaction_voucher_links']) {
      expect(findCalls(table, 'in').map(([, part]) => (part as string[]).length)).toEqual([ID_READ_CHUNK, 38])
    }
    const inserts = findCalls('transaction_voucher_links', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toHaveLength(138)
  })

  it('refuses a transaction that is already booked: junction row, live pointer, payment row, or ignored', async () => {
    // Junction row (bulk-book or an earlier split).
    let m = createQueuedMockSupabase()
    m.enqueue({ data: freeTx({ transaction_voucher_links: [{ journal_entry_id: 'je-x', role: 'bank_line' }] }) })
    let r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1')
    expect(r.error).toBe('Transaktionen är redan kopplad till en verifikation.')
    expect(r.code).toBe('TRANSACTION_ALREADY_LINKED')

    // Live pointer.
    m = createQueuedMockSupabase()
    m.enqueue({ data: freeTx({ journal_entry_id: 'je-live' }) })
    m.enqueue({ data: { status: 'posted' } }) // hasLiveJournalEntryLink
    r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1')
    expect(r.error).toBe('Transaktionen är redan kopplad till en verifikation.')
    expect(r.code).toBe('TRANSACTION_ALREADY_LINKED')

    // Payment row (match-invoice / match-batch).
    m = createQueuedMockSupabase()
    m.enqueue({ data: freeTx() })
    m.enqueue({ data: [{ id: 'ip-1' }] }) // invoice_payments
    m.enqueue({ data: [] })
    r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1')
    expect(r.error).toBe('Transaktionen är redan matchad mot en faktura.')
    expect(r.code).toBe('TRANSACTION_ALREADY_LINKED')

    // Ignored.
    m = createQueuedMockSupabase()
    m.enqueue({ data: freeTx({ is_ignored: true }) })
    r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1')
    expect(r.error).toBe('Transaktionen är ignorerad. Återställ den innan du kopplar.')
    expect(r.code).toBe('TRANSACTION_IGNORED')
  })

  it('re-links a row stranded on a reversed entry (#988), locking on the stale pointer', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: freeTx({ journal_entry_id: 'je-reversed' }) })
    enqueue({ data: { status: 'reversed' } }) // hasLiveJournalEntryLink: stale
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: postedEntries })
    enqueue({ data: bankLines })
    enqueue({ data: [] }) // slices other rows hold on the verifikat
    enqueue({ data: [] }) // pointers of other rows
    enqueue({ data: [{ id: 'tx-1' }] })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result.success).toBe(true)
    expect(findCalls('transactions', 'eq').some((args) => args[0] === 'journal_entry_id' && args[1] === 'je-reversed')).toBe(true)
  })

  it('refuses a verifikat that is not posted, reversed, outside the company, or without a line on the account, each by its code', async () => {
    let m = createQueuedMockSupabase()
    enqueueReads(m.enqueue, { entries: [postedEntries[0], { ...postedEntries[1], status: 'draft' }] })
    let r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1')
    expect(r.error).toBe('Verifikat A12 är inte bokförd ännu.')
    expect(r.code).toBe('ENTRY_NOT_POSTED')

    m = createQueuedMockSupabase()
    enqueueReads(m.enqueue, { entries: [postedEntries[0], { ...postedEntries[1], status: 'reversed' }] })
    r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1')
    expect(r.error).toBe('Verifikat A12 är makulerat och kan inte kopplas.')
    expect(r.code).toBe('ENTRY_REVERSED')

    // Only one of the two ids comes back inside the company: the message
    // names the one that did not, so a mistyped id is findable.
    m = createQueuedMockSupabase()
    enqueueReads(m.enqueue, { entries: [postedEntries[0]] })
    r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1')
    expect(r.error).toBe(`Verifikationen ${E2} kunde inte hittas.`)
    expect(r.code).toBe('ENTRY_NOT_FOUND')

    // E2 books nothing on 1930 (its bank line is on 1940).
    m = createQueuedMockSupabase()
    enqueueReads(m.enqueue, { lines: [bankLines[0]] })
    r = await linkTransactionToVouchers(m.supabase as never, 'company-1', 'tx-1', [{ journal_entry_id: E1 }, { journal_entry_id: E2 }], 'user-1', '1930')
    expect(r.error).toBe('Verifikat A12 saknar rad på 1930')
    expect(r.code).toBe('NOT_SETTLED')
  })

  it('refuses when the transaction belongs to another cash account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: freeTx({ cash_account_id: 'ca-1940' }) })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: { ledger_account: '1940' } }) // cash_accounts cross-check

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toEqual({
      success: false,
      error: 'Transaktionen hör till 1940, inte 1930',
      code: 'TRANSACTION_OTHER_ACCOUNT',
    })
  })

  it('reports a lost race (0 rows locked) as already linked and inserts nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueue({ data: [] }) // lock UPDATE matched nothing

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toEqual({
      success: false,
      error: 'Transaktionen är redan kopplad till en verifikation.',
      code: 'LINK_RACE',
    })
    expect(findCalls('transaction_voucher_links', 'insert')).toEqual([])
  })

  it('rolls the lock back when the junction insert fails', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueue({ data: [{ id: 'tx-1' }] }) // lock UPDATE
    enqueue({ data: null, error: { message: 'duplicate key' } }) // junction insert
    enqueue({ data: null }) // compensating delete
    enqueue({ data: null }) // restore UPDATE

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toEqual({
      success: false,
      error: 'Kunde inte koppla transaktionen. Försök igen.',
      code: 'WRITE_FAILED',
    })
    expect(findCalls('transaction_voucher_links', 'delete')).toHaveLength(1)
    const updates = findCalls('transactions', 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1][0]).toEqual({ journal_entry_id: null, reconciliation_method: null, is_business: null })
    expect(findCalls('payment_match_log', 'insert')).toEqual([])
  })

  it('accepts a mixed-sign split: a payment and a netted credit note (agent feedback seq 853921)', async () => {
    // -100 out of the bank = -120 paid on one verifikat, +20 credited on another.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue, {
      tx: freeTx({ amount: -100 }),
      lines: [
        { journal_entry_id: E1, debit_amount: 0, credit_amount: 120, currency: null, amount_in_currency: null },
        { journal_entry_id: E2, debit_amount: 20, credit_amount: 0, currency: null, amount_in_currency: null },
      ],
    })
    enqueue({ data: [{ id: 'tx-1' }] }) // lock UPDATE
    enqueue({ data: null }) // junction insert
    enqueue({ data: null }) // payment_match_log

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toEqual({
      success: true,
      allocations: [
        { journal_entry_id: E1, amount: -120 },
        { journal_entry_id: E2, amount: 20 },
      ],
    })
    const inserted = findCalls('transaction_voucher_links', 'insert')[0][0] as Array<{ allocated_amount: number }>
    expect(inserted.map((r) => r.allocated_amount)).toEqual([-120, 20])
  })

  it('reports a bank-anchor refusal as BANK_ANCHOR_REFUSED, not a retryable write failure (agent feedback seq 877706)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueue({ data: [{ id: 'tx-1' }] }) // lock UPDATE
    enqueue({ data: null, error: { code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' } }) // junction insert
    enqueue({ data: null }) // compensating delete
    enqueue({ data: null }) // restore UPDATE

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('BANK_ANCHOR_REFUSED')
    expect(result.error).toMatch(/^Kopplingen nekades: verifikationen bokför inte beloppet/)
    expect(result.error).not.toMatch(/Försök igen/)
    // The lock is still rolled back.
    expect(findCalls('transaction_voucher_links', 'delete')).toHaveLength(1)
    expect(findCalls('transactions', 'update')).toHaveLength(2)
  })

  it('reports a changed bank account under the request as BANK_ANCHOR_REFUSED too', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueue({ data: [{ id: 'tx-1' }] })
    enqueue({ data: null, error: { code: 'PT409', message: 'BANK_ANCHOR_CASH_ACCOUNT_CHANGED' } })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toMatchObject({ success: false, code: 'BANK_ANCHOR_REFUSED' })
    expect(result.error).toMatch(/bankkonto finns inte längre/)
    expect(result.error).not.toMatch(/försök igen/i)
  })

  it.each([
    ['BANK_ANCHOR_SPLIT_UNBALANCED', /blir inte tillsammans transaktionens belopp/],
    ['BANK_ANCHOR_BINDING_IN_USE', /redan kopplad på det konto där den ligger/],
    ['BANK_ANCHOR_SOMETHING_NEW', /stämmer inte längre med varandra/],
  ])('gives %s its own reason, never "försök igen"', async (name, reason) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueue({ data: [{ id: 'tx-1' }] })
    enqueue({ data: null, error: { code: 'PT409', message: name } })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toMatchObject({ success: false, code: 'BANK_ANCHOR_REFUSED' })
    expect(result.error).toMatch(reason)
    expect(result.error).not.toMatch(/försök igen/i)
  })

  it('caps a slice at what other rows leave of the verifikat, and defaults an omitted slice to that remainder', async () => {
    // Another row on the same cash account already holds -200 of E1's -500.
    const held = [
      { journal_entry_id: E1, allocated_amount: '-200.00', transactions: { cash_account_id: null, currency: 'SEK' } },
      // A slice on another cash account (the other leg of a transfer) is not this account's share.
      { journal_entry_id: E2, allocated_amount: '-300.00', transactions: { cash_account_id: 'other-cash', currency: 'SEK' } },
    ]

    let m = createQueuedMockSupabase()
    enqueueReads(m.enqueue, { tx: freeTx({ amount: -600 }), held })
    let r = await linkTransactionToVouchers(
      m.supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
      { dryRun: true },
    )
    expect(r).toEqual({
      success: true,
      allocations: [
        { journal_entry_id: E1, amount: -300 },
        { journal_entry_id: E2, amount: -300 },
      ],
    })

    m = createQueuedMockSupabase()
    enqueueReads(m.enqueue, { held })
    r = await linkTransactionToVouchers(
      m.supabase as never,
      'company-1',
      'tx-1',
      [
        { journal_entry_id: E1, amount: -500 },
        { journal_entry_id: E2, amount: -300 },
      ],
      'user-1',
      '1930',
      { dryRun: true },
    )
    expect(r.success).toBe(false)
    expect(r.code).toBe('OVER_ALLOCATED')
    expect(r.error).toBe(
      'Beloppet för verifikat A11 (-500) är större än det som återstår av verifikatets rad på 1930 (-300): resten är redan kopplad till andra transaktioner.',
    )
  })

  it('refuses a verifikat other rows already settle in full', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue, {
      held: [{ journal_entry_id: E2, allocated_amount: -300, transactions: [{ cash_account_id: null, currency: 'SEK' }] }],
    })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toEqual({
      success: false,
      error: 'Verifikat A12 är redan helt kopplat på 1930 till andra transaktioner.',
      code: 'OVER_ALLOCATED',
    })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('counts a row linked 1:1 by its pointer: a split takes no share of a verifikat that row settles in full (GitHub #3507)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueReads(enqueue, {
      pointers: [{ id: 'tx-other', journal_entry_id: E2, amount: -300, currency: 'SEK', cash_account_id: null }],
    })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toEqual({
      success: false,
      error: 'Verifikat A12 är redan helt kopplat på 1930 till andra transaktioner.',
      code: 'OVER_ALLOCATED',
    })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('does not link when the held slices cannot be read', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: freeTx() })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: postedEntries })
    enqueue({ data: bankLines })
    enqueue({ data: null, error: { message: 'boom' } })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toMatchObject({ success: false, code: 'WRITE_FAILED' })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('keeps WRITE_FAILED for a PT409 that is not a bank-anchor refusal', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue)
    enqueue({ data: [{ id: 'tx-1' }] })
    enqueue({ data: null, error: { code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY' } })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = await linkTransactionToVouchers(
      supabase as never,
      'company-1',
      'tx-1',
      [{ journal_entry_id: E1 }, { journal_entry_id: E2 }],
      'user-1',
      '1930',
    )

    expect(result).toMatchObject({ success: false, code: 'WRITE_FAILED' })
  })
})

// ============================================================
// unlinkReconciliation
// ============================================================

describe('unlinkReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function createQueueMockSupabase() {
    const resultQueue: { data: unknown; error: unknown }[] = []

    const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
      for (const r of results) {
        resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
      }
    }

    const buildChain = (): unknown => {
      const handler: ProxyHandler<object> = {
        get(_target, prop) {
          if (prop === 'then') {
            const next = resultQueue.shift() ?? { data: null, error: null }
            return (resolve: (v: unknown) => void) => resolve(next)
          }
          return (..._args: unknown[]) => buildChain()
        },
      }
      return new Proxy({}, handler)
    }

    const supabase = {
      from: vi.fn().mockImplementation(() => buildChain()),
      rpc: vi.fn().mockImplementation(() => buildChain()),
    }

    return { supabase, enqueue }
  }

  it('rejects when transaction has no reconciliation_method (categorization entry)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Transaction found with journal_entry_id but no reconciliation_method
    enqueue({
      data: {
        id: 'tx-1',
        journal_entry_id: 'je-1',
        reconciliation_method: null,
      },
    })

    const result = await unlinkReconciliation(supabase as never, 'company-1', 'tx-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.code).toBe('LINK_IS_BOOKING')
    expect(result.error).toContain('Cannot unlink')
  })

  it('codes the other refusals so the doors answer them typed (PH 194)', async () => {
    const missing = createQueueMockSupabase()
    missing.enqueue({ data: null })
    expect(await unlinkReconciliation(missing.supabase as never, 'company-1', 'tx-1', 'user-1')).toMatchObject({
      success: false,
      code: 'TRANSACTION_NOT_FOUND',
    })

    const readFailed = createQueueMockSupabase()
    readFailed.enqueue({ error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    expect(await unlinkReconciliation(readFailed.supabase as never, 'company-1', 'tx-1', 'user-1')).toMatchObject({
      success: false,
      code: 'DB_ERROR',
      cause: { code: '57014' },
    })

    const writeFailed = createQueueMockSupabase()
    writeFailed.enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1', reconciliation_method: 'manual' } })
    writeFailed.enqueue({ error: { code: '42501', message: 'permission denied' } })
    expect(await unlinkReconciliation(writeFailed.supabase as never, 'company-1', 'tx-1', 'user-1')).toMatchObject({
      success: false,
      code: 'DB_ERROR',
      cause: { code: '42501' },
    })
  })

  it('isUnlinkableBankLink: a link records its method, a booking from the row has none', () => {
    expect(isUnlinkableBankLink({ reconciliation_method: 'manual' })).toBe(true)
    expect(isUnlinkableBankLink({ reconciliation_method: 'auto_exact' })).toBe(true)
    expect(isUnlinkableBankLink({ reconciliation_method: null })).toBe(false)
    expect(isUnlinkableBankLink({})).toBe(false)
  })

  it('succeeds when reconciliation_method is set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Transaction found with reconciliation_method
    enqueue({
      data: {
        id: 'tx-1',
        journal_entry_id: 'je-1',
        reconciliation_method: 'auto_exact',
      },
    })
    // Update succeeds
    enqueue({ data: null, error: null })

    const result = await unlinkReconciliation(supabase as never, 'company-1', 'tx-1', 'user-1')

    expect(result.success).toBe(true)
  })

  it('unlinks a split row (no pointer, junction rows only) and reports every verifikat it was anchored to (#1553)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, reconciliation_method: 'manual' } })
    enqueue({ data: [{ journal_entry_id: 'je-a' }, { journal_entry_id: 'je-b' }] }) // junction rows, read BEFORE the delete
    enqueue({ data: null }) // transactions update
    enqueue({ data: null }) // junction delete

    const result = await unlinkReconciliation(supabase as never, 'company-1', 'tx-1', 'user-1')

    expect(result).toEqual({ success: true, previousJournalEntryIds: ['je-a', 'je-b'] })
  })

  it('still refuses a row with neither pointer nor junction rows', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, reconciliation_method: 'manual' } })
    enqueue({ data: [] })

    const result = await unlinkReconciliation(supabase as never, 'company-1', 'tx-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.code).toBe('NOT_LINKED')
    expect(result.error).toBe('Transaction is not linked to any journal entry')
  })

  it('attributes the audit log row to the acting user, not the company', async () => {
    // Regression: unlinkReconciliation used to pass companyId where
    // logMatchEvent expects userId, so payment_match_log.user_id recorded the
    // company UUID (or the insert failed its FK silently).
    const inserts: Record<string, unknown>[] = []
    const resultQueue: { data: unknown; error: unknown }[] = [
      {
        data: { id: 'tx-1', journal_entry_id: 'je-1', reconciliation_method: 'manual' },
        error: null,
      },
      { data: null, error: null }, // update
    ]
    const buildChain = (table?: string): unknown => {
      const handler: ProxyHandler<object> = {
        get(_target, prop) {
          if (prop === 'then') {
            const next = resultQueue.shift() ?? { data: null, error: null }
            return (resolve: (v: unknown) => void) => resolve(next)
          }
          if (prop === 'insert') {
            return (row: Record<string, unknown>) => {
              if (table === 'payment_match_log') inserts.push(row)
              return buildChain(table)
            }
          }
          return (..._args: unknown[]) => buildChain(table)
        },
      }
      return new Proxy({}, handler)
    }
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => buildChain(table)),
      rpc: vi.fn().mockImplementation(() => buildChain()),
    }

    const result = await unlinkReconciliation(supabase as never, 'company-1', 'tx-1', 'user-1')

    expect(result.success).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].user_id).toBe('user-1')
  })
})

// ============================================================
// getReconciliationStatus: the bridge built from the facts read
// ============================================================
//
// The sets the status is built from (the aligned bank rows, the ledger sums,
// the opening-balance floor, the bank's history, the ledger-only lines) come
// from one RPC, get_bank_reconciliation_facts; its rules are tested against
// real Postgres in tests/pg/bank-reconciliation-facts.pg.test.ts. These tests
// pin what the engine makes of an answer: the difference, the two work lists,
// the residual, the verdict.

type FactsInput = {
  ib_floor?: string | null
  effective_from?: string | null
  gl?: Partial<{ balance: number; opening_balance: number; correction_adjustment: number; unconvertible_line_count: number }>
  bank?: Partial<{
    count: number
    total: number
    inflow: number
    outflow: number
    ignored_count: number
    ignored_total: number
    matched_count: number
    unmatched_count: number
    unmatched_total: number
    history_start: string | null
  }>
  read_window_cash_accounts?: number | null
  saldo?: unknown
  candidates?: Array<Omit<Partial<UnlinkedGLLine>, 'linked_transaction_count'> & { linked_transaction_count?: number | string }>
  entry_amounts?: Record<string, number | null> | null
}

function facts(input: FactsInput = {}) {
  return {
    ib_floor: input.ib_floor ?? null,
    effective_from: input.effective_from ?? null,
    gl: { balance: 0, opening_balance: 0, correction_adjustment: 0, unconvertible_line_count: 0, ...input.gl },
    bank: {
      count: 0,
      total: 0,
      inflow: 0,
      outflow: 0,
      ignored_count: 0,
      ignored_total: 0,
      matched_count: 0,
      unmatched_count: 0,
      unmatched_total: 0,
      history_start: null,
      ...input.bank,
    },
    read_window_cash_accounts: input.read_window_cash_accounts ?? null,
    saldo: input.saldo ?? null,
    candidates: (input.candidates ?? []).map((c) => makeGLLine({ linked_transaction_count: 0, remaining_amount: null, ...c } as Partial<UnlinkedGLLine>)),
    entry_amounts: input.entry_amounts ?? null,
  }
}

/**
 * A client whose facts RPC answers `answer`; every other read (the
 * settlements, a span re-read) is answered from `reads` in order.
 */
function factsSupabase(answer: ReturnType<typeof facts> | { error: { message: string } }, reads: unknown[][] = []) {
  const queue = [...reads]
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const data = queue.shift() ?? []
            return (resolve: (v: unknown) => void) => resolve({ data, error: null })
          }
          return () => chain()
        },
      },
    )
  const rpc = vi.fn((fn: string) => {
    if (fn === 'get_bank_reconciliation_facts') {
      return Promise.resolve('error' in answer ? { data: null, error: answer.error } : { data: answer, error: null })
    }
    return chain()
  })
  return { supabase: { from: vi.fn(() => chain()), rpc }, rpc }
}

describe('getReconciliationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('asks the facts RPC for exactly the account, scope and window it was given', async () => {
    const { supabase, rpc } = factsSupabase(facts())
    const CASH = '11111111-1111-4111-8111-111111111111'

    await getReconciliationStatus(supabase as never, 'company-1', '2026-01-01', '2026-12-31', '1932', 'EUR', CASH, false)

    expect(rpc).toHaveBeenCalledWith('get_bank_reconciliation_facts', {
      p_company_id: 'company-1',
      p_account_number: '1932',
      p_currency: 'EUR',
      p_cash_account_id: CASH,
      p_include_unassigned: false,
      p_date_from: '2026-01-01',
      p_date_to: '2026-12-31',
    })
  })

  it('reads an unbounded window and the legacy unscoped call as nulls', async () => {
    const { supabase, rpc } = factsSupabase(facts())

    await getReconciliationStatus(supabase as never, 'company-1')

    expect(rpc).toHaveBeenCalledWith('get_bank_reconciliation_facts', expect.objectContaining({
      p_account_number: '1930',
      p_currency: 'SEK',
      p_cash_account_id: null,
      p_include_unassigned: true,
      p_date_from: null,
      p_date_to: null,
    }))
  })

  it('refuses a scope it could not have built a filter from', async () => {
    const { supabase, rpc } = factsSupabase(facts())
    await expect(
      getReconciliationStatus(supabase as never, 'company-1', undefined, undefined, '1930', 'sek'),
    ).rejects.toThrow(/invalid currency/)
    await expect(
      getReconciliationStatus(supabase as never, 'company-1', undefined, undefined, '1930', 'SEK', 'not-a-uuid'),
    ).rejects.toThrow(/invalid cashAccountId/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('throws when the facts read fails rather than reporting an empty account', async () => {
    const { supabase } = factsSupabase({ error: { message: 'boom' } })
    await expect(getReconciliationStatus(supabase as never, 'company-1')).rejects.toThrow('boom')
  })

  it('reports is_reconciled=true when only the IB voucher is unmatched on 1930', async () => {
    const { supabase } = factsSupabase(
      facts({
        ib_floor: '2026-01-01',
        effective_from: '2026-01-01',
        gl: { balance: 51000, opening_balance: 50000 },
        bank: { count: 1, total: 1000, inflow: 1000, matched_count: 1 },
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_balance).toBe(51000) // includes IB
    expect(status.gl_1930_period_movement).toBe(1000) // excludes IB
    expect(status.gl_1930_opening_balance).toBe(50000)
    expect(status.bank_transaction_total).toBe(1000)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
    expect(status.unmatched_gl_line_count).toBe(0)
  })

  it('reports is_reconciled=false and a non-zero difference when a real bank tx is unmatched', async () => {
    const { supabase } = factsSupabase(
      facts({
        gl: { balance: 51000, opening_balance: 50000 },
        bank: { count: 2, total: 1500, inflow: 1500, matched_count: 1, unmatched_count: 1, unmatched_total: 500 },
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.bank_transaction_total).toBe(1500)
    expect(status.gl_1930_period_movement).toBe(1000)
    expect(status.difference).toBe(500) // bank > GL period movement
    expect(status.is_reconciled).toBe(false)
    expect(status.unmatched_transaction_count).toBe(1)
    expect(status.unmatched_transaction_total).toBe(500)
  })

  it('handles companies with no IB on 1930 (period_movement === gl_balance)', async () => {
    const { supabase } = factsSupabase(facts({ gl: { balance: 100 }, bank: { count: 1, total: 100, matched_count: 1 } }))

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_opening_balance).toBe(0)
    expect(status.gl_1930_period_movement).toBe(100)
    expect(status.gl_1930_balance).toBe(100)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('surfaces ignored rows beside the bank total, and still reconciles once everything else is booked', async () => {
    const { supabase } = factsSupabase(
      facts({
        gl: { balance: 1000 },
        bank: { count: 1, total: 1000, inflow: 1000, matched_count: 1, ignored_count: 1, ignored_total: 1000 },
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.bank_transaction_total).toBe(1000)
    expect(status.ignored_transaction_count).toBe(1)
    expect(status.ignored_transaction_total).toBe(1000)
    expect(status.difference).toBe(0)
    expect(status.unmatched_transaction_count).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('decomposes the difference into the two work lists (unexplained residual 0)', async () => {
    const { supabase } = factsSupabase(
      facts({
        gl: { balance: 700 },
        bank: { count: 2, total: 1500, inflow: 1500, matched_count: 1, unmatched_count: 1, unmatched_total: 500 },
        candidates: [
          {
            line_id: 'l-lonely',
            journal_entry_id: 'je-lonely',
            debit_amount: 0,
            credit_amount: 300,
            entry_date: '2026-03-01',
            voucher_number: 7,
            entry_description: 'Avgift',
            source_type: 'manual',
          },
        ],
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.bank_transaction_total).toBe(1500)
    expect(status.gl_1930_period_movement).toBe(700)
    expect(status.difference).toBe(800)
    // The two lists the user can actually open...
    expect(status.unmatched_transaction_total).toBe(500)
    expect(status.unmatched_gl_line_count).toBe(1)
    expect(status.unmatched_gl_line_total).toBe(-300)
    // ...account for every krona of it: 800 - 500 + (-300) = 0.
    expect(status.unexplained_difference).toBe(0)
  })

  it('surfaces a residual when a matched pair disagrees in amount', async () => {
    // The bank moved 1000 but the voucher it is matched to books only 900:
    // nothing sits in either work list, yet the sides do not agree.
    const { supabase } = factsSupabase(facts({ gl: { balance: 900 }, bank: { count: 1, total: 1000, matched_count: 1 } }))

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.difference).toBe(100)
    expect(status.unmatched_transaction_total).toBe(0)
    expect(status.unmatched_gl_line_total).toBe(0)
    expect(status.unexplained_difference).toBe(100)
  })

  it('counts only the remainder of a partially allocated verifikat, so a netted credit note explains it (agent feedback seq 854089)', async () => {
    const { supabase } = factsSupabase(
      facts({
        gl: { balance: -500 },
        bank: { count: 1, total: -500, outflow: -500, matched_count: 1 },
        candidates: [
          { line_id: 'l-part', journal_entry_id: 'e-part', credit_amount: 300, entry_date: '2026-08-05', linked_transaction_count: 1, remaining_amount: -200 },
          { line_id: 'l-credit', journal_entry_id: 'e-credit', debit_amount: 200, entry_date: '2026-08-05' },
        ],
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.difference).toBe(0)
    expect(status.unmatched_gl_line_count).toBe(2)
    // -200 left open on e-part, +200 on the credit note.
    expect(status.unmatched_gl_line_total).toBe(0)
    expect(status.unexplained_difference).toBe(0)
  })

  it('reports no residual on a foreign account whose candidate lines carry no FX amount', async () => {
    const { supabase } = factsSupabase(
      facts({
        gl: { balance: 100 },
        bank: { count: 1, total: 100, unmatched_count: 1, unmatched_total: 100 },
        candidates: [{ line_id: 'l-eur', journal_entry_id: 'je-eur', debit_amount: 1150, entry_date: '2026-03-01' }],
        entry_amounts: { 'je-eur': 100 },
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1', undefined, undefined, '1932', 'EUR')

    // Never 0: that would assert the vouchers net to nothing.
    expect(status.unmatched_gl_line_total).toBeNull()
    expect(status.unexplained_difference).toBeNull()
    // The count still works; only the sum is withheld.
    expect(status.unmatched_gl_line_count).toBe(1)
    expect(status.currency).toBe('EUR')
  })

  it('carries the storno and rättelse activity as information inside the movement', async () => {
    const { supabase } = factsSupabase(
      facts({ gl: { balance: 25000, correction_adjustment: 1000 }, bank: { count: 1, total: 25000, matched_count: 1 } }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_balance).toBe(25000)
    expect(status.gl_1930_correction_adjustment).toBe(1000)
    expect(status.gl_1930_period_movement).toBe(25000)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('flags a book-only entry that moves the bank balance with no feed counterpart', async () => {
    const { supabase } = factsSupabase(facts({ gl: { balance: 500 } }))

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_period_movement).toBe(500)
    expect(status.bank_transaction_total).toBe(0)
    expect(status.difference).toBe(-500)
    expect(status.is_reconciled).toBe(false)
  })

  it('is NOT reconciled when two unmatched transactions offset each other', async () => {
    // +500 and -500 net to zero against a zero period movement while BOTH rows
    // are still unbooked affärshändelser, each owing its own verifikation
    // (BFL 5 kap 1-2 §, 6-7 §; ÅRL 2 kap: individuell värdering).
    const { supabase } = factsSupabase(
      facts({
        gl: { balance: 50000, opening_balance: 50000 },
        bank: { count: 2, total: 0, inflow: 500, outflow: -500, unmatched_count: 2, unmatched_total: 0 },
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.difference).toBe(0)
    expect(status.unmatched_transaction_count).toBe(2)
    expect(status.bank_transaction_inflow).toBe(500)
    expect(status.bank_transaction_outflow).toBe(-500)
    expect(status.is_reconciled).toBe(false)
  })

  it('reports not-reconcilable-yet when a foreign account has lines with no amount in that currency', async () => {
    const { supabase } = factsSupabase(
      facts({ gl: { balance: 0, unconvertible_line_count: 1 }, bank: { count: 1, total: 100, matched_count: 1 } }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1', undefined, undefined, '1932', 'EUR')

    expect(status.unconvertible_gl_line_count).toBe(1)
    expect(status.not_reconcilable_reason).toBe('gl_lines_missing_currency_amount')
    expect(status.is_reconciled).toBe(false)
  })

  it('rounds every figure to the öre and coerces the link count off the wire', async () => {
    const { supabase } = factsSupabase(
      facts({
        gl: { balance: 1000.001 },
        bank: { count: 1, total: 1000.004, inflow: 1000.004, matched_count: 1 },
        candidates: [{ journal_entry_id: 'je-x', debit_amount: 0.004, entry_date: '2026-03-01', linked_transaction_count: '2' }],
      }),
    )

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.bank_transaction_total).toBe(1000)
    expect(status.gl_1930_balance).toBe(1000)
    expect(status.difference).toBe(0)
    expect(status.unmatched_gl_line_total).toBe(0)
  })
})

// ============================================================
// Unscoped-run diagnostic (#1290)
// ============================================================
//
// Leaving cashAccountId undefined makes scopeTransactionsToAccount fall back to
// a currency-only filter: the transaction side pools EVERY same-currency cash
// account while the GL side stays on one accountNumber. On the read path that
// is the phantom difference the issue reported; on the write path it can
// auto-link a savings-account transaction to a 1930 voucher. The engine cannot
// refuse (single-account companies with no cash_accounts row legitimately take
// the same fallback), so it warns exactly when the fetched rows really do span
// more than one account.

describe('unscoped cash-account diagnostic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  // A real cash_accounts.id has to survive the UUID assertion inside
  // scopeTransactionsToAccount, so these are shaped like real ones.
  const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
  const ACCOUNT_B = '22222222-2222-4222-8222-222222222222'

  /**
   * The queue-driven proxy the suites above use, plus a record of every builder
   * call so the transactions select list can be pinned.
   */
  function createRecordingMockSupabase() {
    const resultQueue: { data: unknown; error: unknown }[] = []
    const calls: { method: string; args: unknown[] }[] = []

    const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
      for (const r of results) resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
    }

    const buildChain = (): unknown => {
      const handler: ProxyHandler<object> = {
        get(_target, prop) {
          if (prop === 'then') {
            const next = resultQueue.shift() ?? { data: null, error: null }
            return (resolve: (v: unknown) => void) => resolve(next)
          }
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return buildChain()
          }
        },
      }
      return new Proxy({}, handler)
    }

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        calls.push({ method: 'from', args: [table] })
        return buildChain()
      }),
      rpc: vi.fn().mockImplementation((fn: string) => {
        calls.push({ method: 'rpc', args: [fn] })
        return buildChain()
      }),
    }

    return { supabase, enqueue, calls }
  }

  it('warns when getReconciliationStatus runs unscoped over more than one cash account', async () => {
    // The facts read counts the distinct cash accounts among the rows it read
    // on their own date; only an unscoped call is told.
    const { supabase } = factsSupabase(facts({ read_window_cash_accounts: 2 }))

    await getReconciliationStatus(supabase as never, 'company-1')

    expect(logWarn).toHaveBeenCalledWith(
      'getReconciliationStatus ran unscoped across several cash accounts',
      expect.objectContaining({
        companyId: 'company-1',
        operation: 'getReconciliationStatus',
        entityType: 'cash_account',
        details: expect.objectContaining({
          accountNumber: '1930',
          currency: 'SEK',
          distinctCashAccounts: 2,
        }),
      }),
    )
  })

  it('stays silent when getReconciliationStatus is scoped to a cash account', async () => {
    // A scoped call is correct by construction, so it must not warn even
    // when the read reports foreign rows.
    const { supabase } = factsSupabase(facts({ read_window_cash_accounts: 2 }))

    await getReconciliationStatus(
      supabase as never,
      'company-1',
      undefined,
      undefined,
      '1930',
      'SEK',
      ACCOUNT_A,
      true,
    )

    expect(logWarn).not.toHaveBeenCalled()
  })

  it('stays silent when an unscoped run sees one cash account, or only unassigned rows', async () => {
    // The legacy single-account company that has no cash_accounts row at all:
    // the currency-only fallback is the intended behaviour there, not a bug.
    for (const distinct of [1, 0]) {
      const { supabase } = factsSupabase(facts({ read_window_cash_accounts: distinct }))
      await getReconciliationStatus(supabase as never, 'company-1')
    }

    expect(logWarn).not.toHaveBeenCalled()
  })

  it('warns when runReconciliation runs unscoped over more than one cash account', async () => {
    // The WRITE path: this sweep applies matches, so pooling here can persist a
    // wrong journal_entry_id, not merely display a wrong figure.
    const { supabase, enqueue } = createRecordingMockSupabase()
    enqueue({ data: [] })  // RPC: unlinked GL lines
    enqueue({
      data: [
        makeTransaction({ id: 'tx-1', cash_account_id: ACCOUNT_A }),
        makeTransaction({ id: 'tx-2', cash_account_id: ACCOUNT_B }),
      ],
    })

    await runReconciliation(supabase as never, 'company-1', 'user-1')

    expect(logWarn).toHaveBeenCalledWith(
      'runReconciliation ran unscoped across several cash accounts',
      expect.objectContaining({
        companyId: 'company-1',
        operation: 'runReconciliation',
        entityType: 'cash_account',
        details: expect.objectContaining({
          accountNumber: '1930',
          currency: 'SEK',
          distinctCashAccounts: 2,
        }),
      }),
    )
  })

  it('stays silent when runReconciliation is scoped to a cash account', async () => {
    const { supabase, enqueue } = createRecordingMockSupabase()
    enqueue({ data: [] })
    enqueue({
      data: [
        makeTransaction({ id: 'tx-1', cash_account_id: ACCOUNT_A }),
        makeTransaction({ id: 'tx-2', cash_account_id: ACCOUNT_B }),
      ],
    })

    await runReconciliation(supabase as never, 'company-1', 'user-1', {
      cashAccountId: ACCOUNT_A,
      includeUnassigned: true,
    })

    expect(logWarn).not.toHaveBeenCalled()
  })
})

describe('openAmountByEntry', () => {
  it('nets several lines of one verifikat and keeps verifikat apart', () => {
    const open = openAmountByEntry(
      [
        makeGLLine({ journal_entry_id: 'e-1', debit_amount: 100 }),
        makeGLLine({ journal_entry_id: 'e-1', credit_amount: 30 }),
        makeGLLine({ journal_entry_id: 'e-2', credit_amount: 45.5 }),
      ],
      'SEK',
    )
    expect([...open]).toEqual([
      ['e-1', 70],
      ['e-2', -45.5],
    ])
  })

  it('uses the remainder of a partially allocated verifikat instead of its lines', () => {
    const open = openAmountByEntry(
      [
        makeGLLine({ journal_entry_id: 'e-part', credit_amount: 2000, remaining_amount: '-1750.00' }),
        makeGLLine({ journal_entry_id: 'e-part', credit_amount: 500, remaining_amount: '-1750.00' }),
      ],
      'SEK',
    )
    expect(open.get('e-part')).toBe(-1750)
  })

  it('stays null on a foreign account whose lines carry no amount in its currency', () => {
    const open = openAmountByEntry([makeGLLine({ journal_entry_id: 'e-1', debit_amount: 100 })], 'EUR')
    expect(open.get('e-1')).toBeNull()
  })
})

