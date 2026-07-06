import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let calls: Array<{ method: string; args: unknown[] }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'range']) {
    b[m] = vi.fn().mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args })
      return b
    })
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateReconciliation } from '../supplier-reconciliation'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  calls = []
  supabase = makeClient()
})

describe('generateReconciliation', () => {
  it('returns reconciled when supplier total matches account 2440 balance', async () => {
    results = [
      // 0: supplier_invoices
      {
        data: [
          { remaining_amount: 5000 },
          { remaining_amount: 3000 },
        ],
        error: null,
      },
      // 1: journal_entry_lines for account 2440
      {
        data: [
          { debit_amount: 0, credit_amount: 10000, journal_entry_id: 'e1' },
          { debit_amount: 2000, credit_amount: 0, journal_entry_id: 'e2' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Supplier total: 5000 + 3000 = 8000
    expect(result.supplier_ledger_total).toBe(8000)
    // Account 2440 (credit-normal): credits - debits = 10000 - 2000 = 8000
    expect(result.account_2440_balance).toBe(8000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('paginates the 2440 ledger query: sums >1000 lines instead of truncating at 1000', async () => {
    // Regression guard for the silent PostgREST 1000-row cap: fetchAllRows must
    // page through ALL ledger lines. A full first page (length === PAGE_SIZE)
    // forces a second fetch.
    // Unique ids so the dedupe-by-id safety net doesn't collapse rows.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `p1-${i}`, debit_amount: 0, credit_amount: 10 }))
    const page2 = Array.from({ length: 500 }, (_, i) => ({ id: `p2-${i}`, debit_amount: 0, credit_amount: 10 }))
    results = [
      { data: [], error: null },     // 0: supplier_invoices, none open
      { data: page1, error: null },  // 1: 2440 lines page 1 (full → triggers next page)
      { data: page2, error: null },  // 2: 2440 lines page 2 (partial → stop)
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // 1500 lines × 10 = 15 000. A 1000-row truncation would wrongly yield 10 000.
    expect(result.account_2440_balance).toBe(15000)
  })

  it('detects mismatch when difference != 0', async () => {
    results = [
      // 0: supplier_invoices, total 5000
      {
        data: [
          { remaining_amount: 5000 },
        ],
        error: null,
      },
      // 1: journal_entry_lines, balance 7000
      {
        data: [
          { debit_amount: 0, credit_amount: 7000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(5000)
    expect(result.account_2440_balance).toBe(7000)
    expect(result.difference).toBe(-2000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns reconciled when both are zero/empty', async () => {
    results = [
      { data: [], error: null },
      { data: [], error: null },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('handles null invoice data gracefully', async () => {
    results = [
      { data: null, error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 3000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(3000)
    expect(result.difference).toBe(-3000)
    expect(result.is_reconciled).toBe(false)
  })

  it('computes credit-normal balance for account 2440 (liability)', async () => {
    results = [
      { data: [], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 15000, journal_entry_id: 'e1' },
          { debit_amount: 5000, credit_amount: 0, journal_entry_id: 'e2' },
          { debit_amount: 3000, credit_amount: 0, journal_entry_id: 'e3' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Balance = credits - debits = 15000 - 5000 - 3000 = 7000
    expect(result.account_2440_balance).toBe(7000)
  })

  it('converts foreign-currency remaining_amount to SEK before reconciliation', async () => {
    // Reproduces the production bug: 225 EUR + 1 000 SEK was reported as 1 225
    // against a 2440 balance of 3 475, flagging a false discrepancy.
    results = [
      // 0: supplier_invoices, 225 EUR at 11, plus 1 000 SEK
      {
        data: [
          { remaining_amount: 225, currency: 'EUR', exchange_rate: 11 },
          { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 2440 balance = 3 475 SEK (matches converted ledger total)
      {
        data: [
          { debit_amount: 0, credit_amount: 3475, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(3475)
    expect(result.account_2440_balance).toBe(3475)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    // An FX invoice without an exchange rate cannot be converted to SEK; the
    // sum must not silently add raw foreign currency. The row is excluded and
    // counted, so the UI can warn that the reconciliation may be unreliable.
    results = [
      // 0: supplier_invoices, 100 EUR with no rate (excluded), 1 000 SEK control
      {
        data: [
          { remaining_amount: 100, currency: 'EUR', exchange_rate: null },
          { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 2440 balance reflects only the SEK invoice
      {
        data: [
          { debit_amount: 0, credit_amount: 1000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.unconverted_fx_count).toBe(1)
    // EUR row excluded → ledger total is just the SEK 1 000
    expect(result.supplier_ledger_total).toBe(1000)
    expect(result.account_2440_balance).toBe(1000)
    // Numbers match, but the calculation is incomplete (a row was excluded);
    // BFL 5 kap requires the period not be stamped Avstämd until the missing
    // exchange rate is filled in.
    expect(result.is_reconciled).toBe(false)
  })

  it('counts posted AND reversed 2440 lines (corrected invoice nets correctly)', async () => {
    // Regression for the Arcim Technology AB false "Ej avstämd" gap: two supplier
    // invoices were registered, corrected via the storno flow, and fully paid.
    // The corrected registrations flip to status='reversed'. The leverantörs-
    // reskontra shows 0 outstanding, and over posted+reversed the 2440 balance is
    // 0 too, but a posted-only query saw only the storno + correction + payment
    // legs and reported a phantom −41 121,25 kr debit. The query must include the
    // reversed registration leg so both reconcile.
    results = [
      // 0: supplier_invoices, both paid, nothing outstanding
      { data: [], error: null },
      // 1: 2440 lines as returned by the posted+reversed query for one corrected,
      //    paid invoice of 11 231,25: registration (reversed credit), storno
      //    (debit), correction (credit), payment (debit). Net credit−debit = 0.
      {
        data: [
          { debit_amount: 0, credit_amount: 11231.25, journal_entry_id: 'reg-reversed' },
          { debit_amount: 11231.25, credit_amount: 0, journal_entry_id: 'storno' },
          { debit_amount: 0, credit_amount: 11231.25, journal_entry_id: 'correction' },
          { debit_amount: 11231.25, credit_amount: 0, journal_entry_id: 'payment' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)

    // Guard the actual fix: the 2440 query must include reversed entries, not
    // filter to posted-only (which excluded the reversed registration leg).
    const statusFilter = calls.find(
      (c) => c.method === 'in' && c.args[0] === 'journal_entries.status',
    )
    expect(statusFilter?.args[1]).toEqual(['posted', 'reversed'])
  })

  it('uses Math.round for monetary precision', async () => {
    results = [
      {
        data: [
          { remaining_amount: 33.33 },
          { remaining_amount: 33.34 },
        ],
        error: null,
      },
      {
        data: [
          { debit_amount: 0, credit_amount: 66.67, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(66.67)
    expect(result.account_2440_balance).toBe(66.67)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})
