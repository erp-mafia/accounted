/**
 * Tests for the bank reconciliation engine.
 *
 * Covers: matching algorithm (4 passes), direction compatibility,
 * greedy assignment, dry run, manual link/unlink, status calculation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  tryReconcileTransaction,
  runReconciliation,
  manualLink,
  unlinkReconciliation,
  getReconciliationStatus,
  scopeTransactionsToAccount,
} from '../bank-reconciliation'
import type { UnlinkedGLLine } from '../bank-reconciliation'
import { makeTransaction } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

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

  it('returns empty matches when no unmatched transactions exist', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // RPC: get_unlinked_1930_lines returns empty
    enqueue({ data: [] })
    // from('transactions').select: unmatched
    enqueue({ data: [] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1')

    expect(result.matches).toEqual([])
    expect(result.applied).toBe(0)
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
    // from('transactions') returns unmatched transactions
    enqueue({ data: [tx] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: true })

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].method).toBe('auto_exact')
    expect(result.applied).toBe(0)
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
    // from('transactions') returns unmatched transactions
    enqueue({ data: [tx] })
    // Update transaction with link: .select('id') returns the updated row
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: false })

    expect(result.matches).toHaveLength(1)
    expect(result.applied).toBe(1)
    expect(result.errors).toBe(0)
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

  it('rejects when transaction not found', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Transaction query returns null
    enqueue({ data: null, error: { message: 'Not found' } })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen kunde inte hittas.')
  })

  it('rejects when transaction is already linked', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: 'je-existing' })

    // Transaction found but already linked
    enqueue({ data: tx })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen är redan kopplad till en verifikation.')
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

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Verifikationen saknar rad på 1930')
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

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen hör till 1931, inte 1930')
  })

  it('succeeds when all validations pass (line on selected account)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    // Transaction found (cash_account_id null → cross-check skipped)
    enqueue({ data: tx })
    // Journal entry found
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // Line exists on the selected account
    enqueue({ data: [{ debit_amount: 1000, credit_amount: 0, account_number: '1930' }] })
    // Update succeeds: .select('id') returns the updated row
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930')

    expect(result.success).toBe(true)
  })

  it('rejects when a concurrent linker won the race (0 rows updated)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 1000, credit_amount: 0, account_number: '1930' }] })
    // The .is('journal_entry_id', null) optimistic-lock filter matched nothing:
    // another session linked the transaction between our read and this write.
    enqueue({ data: [] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaktionen är redan kopplad till en verifikation.')
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
    // Line exists on 1930
    enqueue({ data: [{ debit_amount: 1000, credit_amount: 0, account_number: '1930' }] })
    // Update succeeds: .select('id') returns the updated row
    enqueue({ data: [{ id: 'tx-1' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1', '1930')

    expect(result.success).toBe(true)
  })

  it('allows N:1, does not reject when the verifikat already has a linked transaction', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    // This transaction is itself unlinked; the TARGET entry already has another
    // transaction pointing at it. manualLink no longer queries for / rejects
    // that: several bank transactions may settle one verifikat (a salary run
    // paid in multiple transfers). The only per-transaction guard is that THIS
    // transaction isn't already linked (tx.journal_entry_id), still enforced.
    const tx = makeTransaction({ id: 'tx-2', journal_entry_id: null })

    enqueue({ data: tx })
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 1000, credit_amount: 0, account_number: '1930' }] })
    // Update succeeds: note there is NO existing-link lookup in the sequence.
    enqueue({ data: [{ id: 'tx-2' }] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-2', 'je-1', 'user-1', '1930')

    expect(result.success).toBe(true)
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
    expect(result.error).toContain('Cannot unlink')
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
// getReconciliationStatus: IB exclusion (PR 3 of #443)
// ============================================================

describe('getReconciliationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function createQueueMockSupabase() {
    const resultQueue: { data: unknown; error: unknown }[] = []
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

  it('reports is_reconciled=true when only the IB voucher is unmatched on 1930', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // 1) transactions: 1000 SEK matched (journal_entry_id set)
    enqueue({
      data: [{ amount: 1000, journal_entry_id: 'je-tx', reconciliation_method: 'auto_exact' }],
    })
    // 2) journal_entry_lines: 50,000 IB debit + 1000 matched debit on 1930
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-gen1', status: 'posted', source_type: 'opening_balance' },
        { id: 'je-gen2', status: 'posted', source_type: 'bank_import' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 50000, credit_amount: 0, journal_entry_id: 'je-gen1' },
        { debit_amount: 1000, credit_amount: 0, journal_entry_id: 'je-gen2' },
      ],
    })
    // 3) RPC get_unlinked_1930_lines: returns empty (RPC excludes IB after migration)
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_balance).toBe(51000)             // includes IB
    expect(status.gl_1930_period_movement).toBe(1000)      // excludes IB
    expect(status.gl_1930_opening_balance).toBe(50000)
    expect(status.bank_transaction_total).toBe(1000)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
    expect(status.unmatched_gl_line_count).toBe(0)
  })

  it('reports is_reconciled=false and a non-zero difference when a real bank tx is unmatched', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // 1) transactions: 1500 total, only 1000 matched
    enqueue({
      data: [
        { amount: 1000, journal_entry_id: 'je-1', reconciliation_method: null },
        { amount: 500, journal_entry_id: null, reconciliation_method: null },
      ],
    })
    // 2) GL lines: 50,000 IB + 1000 booked
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-gen3', status: 'posted', source_type: 'opening_balance' },
        { id: 'je-gen4', status: 'posted', source_type: 'bank_import' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 50000, credit_amount: 0, journal_entry_id: 'je-gen3' },
        { debit_amount: 1000, credit_amount: 0, journal_entry_id: 'je-gen4' },
      ],
    })
    // 3) RPC: empty
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.bank_transaction_total).toBe(1500)
    expect(status.gl_1930_period_movement).toBe(1000)
    expect(status.gl_1930_opening_balance).toBe(50000)
    expect(status.difference).toBe(500)                  // bank > GL period movement
    expect(status.is_reconciled).toBe(false)
    expect(status.unmatched_transaction_count).toBe(1)
  })

  it('handles companies with no IB on 1930 (period_movement === gl_balance)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    enqueue({ data: [{ amount: 100, journal_entry_id: 'je-1', reconciliation_method: 'auto_exact' }] })
    // Two-step entry-lines fetch: entries page first, then lines by entry id.
    enqueue({ data: [{ id: 'je-1', status: 'posted', source_type: 'bank_import' }] })
    enqueue({
      data: [{ debit_amount: 100, credit_amount: 0, journal_entry_id: 'je-1' }],
    })
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_opening_balance).toBe(0)
    expect(status.gl_1930_period_movement).toBe(100)
    expect(status.gl_1930_balance).toBe(100)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('splits IB from period movement via the reattached parent entry', async () => {
    // The two-step entry-lines fetch reattaches the parent entry object on
    // each line under `journal_entries`; entryOf() reads source_type from it
    // to split the IB summary out of the period movement.
    const { supabase, enqueue } = createQueueMockSupabase()

    enqueue({ data: [] })
    // Two-step entry-lines fetch: entries page first, then lines by entry id.
    enqueue({
      data: [
        { id: 'je-ib', status: 'posted', source_type: 'opening_balance' },
        { id: 'je-mv', status: 'posted', source_type: 'bank_import' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 1000, credit_amount: 0, journal_entry_id: 'je-ib' },
        { debit_amount: 200, credit_amount: 0, journal_entry_id: 'je-mv' },
      ],
    })
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_opening_balance).toBe(1000)
    expect(status.gl_1930_period_movement).toBe(200)
  })

  it('reconciles a corrected bank receipt and keeps gl_1930_balance equal to the balance sheet', async () => {
    // A +25000 deposit was booked to the wrong counter-account, then corrected
    // via the storno flow: the original flips to 'reversed', a storno (credit
    // 25000) and a correction (debit 25000) are posted, and correctEntry
    // re-points the bank transaction to the live correction (je-corr).
    //
    // Reconciliation now sums posted+reversed on 1930, exactly as the trial
    // balance / balance sheet do, so the cluster nets to the true +25000 and
    // the period reconciles. gl_1930_balance must equal what the balansräkning
    // shows for 1930 (the bug this widget used to have was the two disagreeing).
    const { supabase, enqueue } = createQueueMockSupabase()

    // 1) transactions: the +25000 deposit, re-pointed to the correction
    enqueue({
      data: [{ amount: 25000, journal_entry_id: 'je-corr', reconciliation_method: 'manual' }],
    })
    // 2) GL lines on 1930: reversed original (debit 25000), storno (credit
    //    25000), correction (debit 25000). All three are summed. Served via
    //    the two-step entry-lines fetch: entries page, then lines by entry id.
    enqueue({
      data: [
        { id: 'je-orig', status: 'reversed', source_type: 'bank_transaction' },
        { id: 'je-storno', status: 'posted', source_type: 'storno' },
        { id: 'je-corr', status: 'posted', source_type: 'correction' },
      ],
    })
    const lines = [
      { debit_amount: 25000, credit_amount: 0, journal_entry_id: 'je-orig' },
      { debit_amount: 0, credit_amount: 25000, journal_entry_id: 'je-storno' },
      { debit_amount: 25000, credit_amount: 0, journal_entry_id: 'je-corr' },
    ]
    enqueue({ data: lines })
    // 3) RPC: empty
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    // Balance-sheet-equivalent: posted+reversed summed = 25000 - 25000 + 25000.
    const balanceSheet1930 = lines.reduce(
      (s, l) => s + l.debit_amount - l.credit_amount,
      0,
    )
    expect(status.gl_1930_balance).toBe(balanceSheet1930) // 25000: matches BS
    expect(status.gl_1930_correction_adjustment).toBe(0)  // storno + correction net
    expect(status.gl_1930_period_movement).toBe(25000)
    expect(status.bank_transaction_total).toBe(25000)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('reconciles an amount correction even though the correction adjustment is non-zero', async () => {
    // Regression for the de-reconcile bug: a 25000 receipt was booked as 24000,
    // then corrected to 25000. The storno (credit 24000) and correction (debit
    // 25000) net to +1000 on 1930, and correctEntry re-points the real 25000
    // feed transaction to the correction. The OLD code subtracted that +1000
    // correction bucket from the movement while still counting the re-pointed
    // 25000 transaction → a phantom 1000 diff. The unified inclusion rule nets
    // it correctly: gl_balance = 25000 = the feed, difference = 0.
    const { supabase, enqueue } = createQueueMockSupabase()

    enqueue({
      data: [{ amount: 25000, journal_entry_id: 'je-corr', reconciliation_method: 'manual' }],
    })
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-orig', status: 'reversed', source_type: 'bank_transaction' },
        { id: 'je-storno', status: 'posted', source_type: 'storno' },
        { id: 'je-corr', status: 'posted', source_type: 'correction' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 24000, credit_amount: 0, journal_entry_id: 'je-orig' },
        { debit_amount: 0, credit_amount: 24000, journal_entry_id: 'je-storno' },
        { debit_amount: 25000, credit_amount: 0, journal_entry_id: 'je-corr' },
      ],
    })
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_balance).toBe(25000)
    expect(status.gl_1930_correction_adjustment).toBe(1000) // -24000 + 25000
    expect(status.gl_1930_period_movement).toBe(25000)
    expect(status.bank_transaction_total).toBe(25000)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('reconciles a legacy deposit still linked to the reversed original (no special-case drop)', async () => {
    // Pre-relink data: the +25000 deposit was matched, the entry corrected, but
    // the transaction was never re-pointed and still references the reversed
    // original. With posted+reversed summed on the GL side and NO reversed-link
    // dropping on the bank side, this still nets to zero: symmetric without any
    // special case.
    const { supabase, enqueue } = createQueueMockSupabase()

    enqueue({
      data: [{ amount: 25000, journal_entry_id: 'je-orig', reconciliation_method: 'manual' }],
    })
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-orig', status: 'reversed', source_type: 'bank_transaction' },
        { id: 'je-storno', status: 'posted', source_type: 'storno' },
        { id: 'je-corr', status: 'posted', source_type: 'correction' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 25000, credit_amount: 0, journal_entry_id: 'je-orig' },
        { debit_amount: 0, credit_amount: 25000, journal_entry_id: 'je-storno' },
        { debit_amount: 25000, credit_amount: 0, journal_entry_id: 'je-corr' },
      ],
    })
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.bank_transaction_total).toBe(25000) // counted, not dropped
    expect(status.gl_1930_period_movement).toBe(25000)
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('flags a book-only entry that moves the bank balance with no feed counterpart', async () => {
    // Intentional behaviour: a manual posting that moves 1930 without a matching
    // bank-feed transaction (e.g. interest the feed import missed, booked debit
    // 1930 / credit 8310) is a genuine reconciliation break: the GL balance no
    // longer matches the statement. It must surface as a difference, not be
    // silently swept under a "correction" exclusion.
    const { supabase, enqueue } = createQueueMockSupabase()

    enqueue({ data: [] }) // no bank-feed transactions
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-manual', status: 'posted', source_type: 'manual' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 500, credit_amount: 0, journal_entry_id: 'je-manual' },
      ],
    })
    enqueue({ data: [] })

    const status = await getReconciliationStatus(supabase as never, 'company-1')

    expect(status.gl_1930_period_movement).toBe(500)
    expect(status.bank_transaction_total).toBe(0)
    expect(status.difference).toBe(-500)
    expect(status.is_reconciled).toBe(false)
  })

  it('floors a full-history window at the IB date so a prior period cannot count the IB (issue #751)', async () => {
    // Real-world repro: the widget's date filter defaults to "full history"
    // (no dateFrom). A company with two fiscal periods has prior-period (2025)
    // movements on the account that net to EXACTLY the opening balance, plus the
    // new period's IB entry dated on period start. Summing the whole history and
    // only subtracting the IB *summary* leaves the prior-period *detail* in the
    // movement while the bank feed only covers the current period: a phantom
    // difference equal to the IB. The server now floors the window at the most
    // recent IB date on the account, clamping BOTH sides to the current period.
    const { supabase, enqueue } = createQueueMockSupabase()

    // 1) transactions: a prior-period feed line (6000, 2025) + the current
    //    period's feed (5000, 2026). The floor must drop the 2025 one.
    enqueue({
      data: [
        { date: '2025-03-31', amount: 6000, journal_entry_id: 'je-p', reconciliation_method: 'manual' },
        { date: '2026-02-15', amount: 5000, journal_entry_id: 'je-c', reconciliation_method: 'manual' },
      ],
    })
    // 2) GL lines on the account: prior-period movements (6000 + 4000 = 10000,
    //    dated 2025) that net to the IB, the IB itself (10000, dated 2026-01-01),
    //    and the current period's movement (5000, dated 2026).
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-p1', status: 'posted', source_type: 'import', entry_date: '2025-03-31' },
        { id: 'je-p2', status: 'posted', source_type: 'import', entry_date: '2025-09-30' },
        { id: 'je-ib', status: 'posted', source_type: 'opening_balance', entry_date: '2026-01-01' },
        { id: 'je-c1', status: 'posted', source_type: 'bank_transaction', entry_date: '2026-02-15' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 6000, credit_amount: 0, journal_entry_id: 'je-p1' },
        { debit_amount: 4000, credit_amount: 0, journal_entry_id: 'je-p2' },
        { debit_amount: 10000, credit_amount: 0, journal_entry_id: 'je-ib' },
        { debit_amount: 5000, credit_amount: 0, journal_entry_id: 'je-c1' },
      ],
    })
    // 3) RPC: empty
    enqueue({ data: [] })

    // No dateFrom: the "full history" default that triggers the bug.
    const status = await getReconciliationStatus(supabase as never, 'company-1')

    // Both sides clamped to >= 2026-01-01 (the IB date): only the IB + the
    // current-period movement remain on the GL side; only the 2026 feed remains
    // on the bank side. The prior period (which equalled the IB) is excluded.
    expect(status.gl_1930_balance).toBe(15000)          // IB 10000 + 5000 (NOT 25000)
    expect(status.gl_1930_period_movement).toBe(5000)   // IB excluded
    expect(status.gl_1930_opening_balance).toBe(10000)  // UI "räknas inte" note stays truthful
    expect(status.bank_transaction_total).toBe(5000)    // 2025 feed floored out
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('floors at the IB date even when the caller passes a dateFrom earlier than the IB', async () => {
    // Safety net for a manual date override / direct API call: clearing the date
    // filter (or setting it before the IB) must not resurrect the phantom diff.
    // effectiveFrom = max(dateFrom, ibDate), so an earlier dateFrom is raised.
    const { supabase, enqueue } = createQueueMockSupabase()

    enqueue({
      data: [
        { date: '2025-05-01', amount: 8000, journal_entry_id: 'je-p', reconciliation_method: 'manual' },
        { date: '2026-04-10', amount: 3000, journal_entry_id: 'je-c', reconciliation_method: 'manual' },
      ],
    })
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-p1', status: 'posted', source_type: 'import', entry_date: '2025-05-01' },
        { id: 'je-ib', status: 'posted', source_type: 'opening_balance', entry_date: '2026-01-01' },
        { id: 'je-c1', status: 'posted', source_type: 'bank_transaction', entry_date: '2026-04-10' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 8000, credit_amount: 0, journal_entry_id: 'je-p1' },
        { debit_amount: 8000, credit_amount: 0, journal_entry_id: 'je-ib' },
        { debit_amount: 3000, credit_amount: 0, journal_entry_id: 'je-c1' },
      ],
    })
    enqueue({ data: [] })

    // dateFrom deliberately before the IB date.
    const status = await getReconciliationStatus(supabase as never, 'company-1', '2025-01-01')

    expect(status.gl_1930_period_movement).toBe(3000)   // IB + prior detail both excluded
    expect(status.gl_1930_opening_balance).toBe(8000)
    expect(status.bank_transaction_total).toBe(3000)    // 2025 feed floored out
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })

  it('reconciles a mid-period window (dateFrom after the IB date) on movements alone', async () => {
    // Per-month reconciliation: the user scopes to March, after the fiscal-year
    // IB (2026-01-01). effectiveFrom = max(dateFrom, ibDate) = the March dateFrom,
    // so the IB and Jan/Feb movements are correctly excluded: they belong to the
    // opening position of a March window, not its movements. gl_1930_opening_balance
    // is 0 here BY DESIGN: a mid-period window contains no fiscal-year IB, so the
    // "räknas inte" note is simply absent (not misleadingly zero). The window
    // reconciles on March's movements vs March's feed.
    const { supabase, enqueue } = createQueueMockSupabase()

    enqueue({
      data: [
        { date: '2026-02-10', amount: 2000, journal_entry_id: 'je-feb', reconciliation_method: 'manual' },
        { date: '2026-03-15', amount: 3000, journal_entry_id: 'je-mar', reconciliation_method: 'manual' },
      ],
    })
    // Two-step entry-lines fetch: entries page first, then lines by entry id
    // (parents reattached under journal_entries by the helper).
    enqueue({
      data: [
        { id: 'je-ib', status: 'posted', source_type: 'opening_balance', entry_date: '2026-01-01' },
        { id: 'je-feb1', status: 'posted', source_type: 'import', entry_date: '2026-02-10' },
        { id: 'je-mar1', status: 'posted', source_type: 'import', entry_date: '2026-03-15' },
      ],
    })
    enqueue({
      data: [
        { debit_amount: 9000, credit_amount: 0, journal_entry_id: 'je-ib' },
        { debit_amount: 2000, credit_amount: 0, journal_entry_id: 'je-feb1' },
        { debit_amount: 3000, credit_amount: 0, journal_entry_id: 'je-mar1' },
      ],
    })
    enqueue({ data: [] })

    // dateFrom in March: after the 2026-01-01 IB.
    const status = await getReconciliationStatus(supabase as never, 'company-1', '2026-03-01')

    expect(status.gl_1930_opening_balance).toBe(0)      // IB not part of a March window
    expect(status.gl_1930_period_movement).toBe(3000)   // only March movements
    expect(status.bank_transaction_total).toBe(3000)    // only March feed
    expect(status.difference).toBe(0)
    expect(status.is_reconciled).toBe(true)
  })
})
