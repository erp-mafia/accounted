import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock — sequential result queue
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

import { generateARReconciliation } from '../ar-reconciliation'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  calls = []
  supabase = makeClient()
})

describe('generateARReconciliation', () => {
  it('returns reconciled when AR ledger matches account 1510', async () => {
    results = [
      // 0: invoices
      {
        data: [
          { total: 5000, paid_amount: 2000 },
          { total: 3000, paid_amount: 0 },
        ],
        error: null,
      },
      // 1: journal_entry_lines for account 1510
      {
        data: [
          { debit_amount: 8000, credit_amount: 0, journal_entry_id: 'e1' },
          { debit_amount: 0, credit_amount: 2000, journal_entry_id: 'e2' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // AR: (5000-2000) + (3000-0) = 6000
    expect(result.ar_ledger_total).toBe(6000)
    // 1510: 8000 - 2000 = 6000
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('detects difference when AR ledger does not match account 1510', async () => {
    results = [
      // 0: invoices
      {
        data: [
          { total: 5000, paid_amount: 0 },
        ],
        error: null,
      },
      // 1: journal_entry_lines — manual debit on 1510 creates mismatch
      {
        data: [
          { debit_amount: 5000, credit_amount: 0, journal_entry_id: 'e1' },
          { debit_amount: 1000, credit_amount: 0, journal_entry_id: 'e2' }, // manual entry
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(5000)
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(-1000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns zero balances when no data exists', async () => {
    results = [
      { data: [], error: null },
      { data: [], error: null },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(0)
    expect(result.account_1510_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('handles null invoice data gracefully', async () => {
    results = [
      { data: null, error: null },
      {
        data: [
          { debit_amount: 3000, credit_amount: 0, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(0)
    expect(result.account_1510_balance).toBe(3000)
    expect(result.difference).toBe(-3000)
    expect(result.is_reconciled).toBe(false)
  })

  it('uses correct debit-normal balance for account 1510 (asset)', async () => {
    results = [
      { data: [], error: null },
      {
        data: [
          { debit_amount: 10000, credit_amount: 0, journal_entry_id: 'e1' },
          { debit_amount: 0, credit_amount: 4000, journal_entry_id: 'e2' },
          { debit_amount: 0, credit_amount: 3000, journal_entry_id: 'e3' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // Balance = debits - credits = 10000 - 4000 - 3000 = 3000
    expect(result.account_1510_balance).toBe(3000)
  })

  it('converts foreign-currency outstanding to SEK before reconciliation', async () => {
    results = [
      // 0: invoices — 225 EUR at 11 (with 25 EUR paid) → 200 EUR → 2 200 SEK,
      //    plus 1 000 SEK invoice (no payment)
      {
        data: [
          { total: 225, paid_amount: 25, currency: 'EUR', exchange_rate: 11 },
          { total: 1000, paid_amount: 0, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 1510 balance = 3 200 SEK
      {
        data: [
          { debit_amount: 3200, credit_amount: 0, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(3200)
    expect(result.account_1510_balance).toBe(3200)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    results = [
      // 0: invoices — 100 EUR without rate (excluded), 500 SEK control
      {
        data: [
          { total: 100, paid_amount: 0, currency: 'EUR', exchange_rate: null },
          { total: 500, paid_amount: 0, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 1510 balance reflects only the SEK invoice
      {
        data: [
          { debit_amount: 500, credit_amount: 0, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.unconverted_fx_count).toBe(1)
    // EUR row excluded → ledger total is just the SEK 500
    expect(result.ar_ledger_total).toBe(500)
    expect(result.account_1510_balance).toBe(500)
    // Numbers match, but the calculation is incomplete (a row was excluded);
    // BFL 5 kap requires the period not be stamped Avstämd until the missing
    // exchange rate is filled in.
    expect(result.is_reconciled).toBe(false)
  })

  it('sums 1510 + 1513 in the GL balance for ROT/RUT fakturamodellen', async () => {
    // Forward-looking: today no postings hit 1513, but if a fakturamodellen
    // invoice ever splits the AR receivable across 1510 (customer portion)
    // and 1513 (Skatteverket claim), both must be included to reconcile.
    results = [
      // 0: invoices — single 1 500 SEK invoice
      {
        data: [{ total: 1500, paid_amount: 0, currency: 'SEK', exchange_rate: null }],
        error: null,
      },
      // 1: GL — 1 200 on 1510, 300 on 1513 → combined 1 500
      {
        data: [
          { debit_amount: 1200, credit_amount: 0, journal_entry_id: 'e1' },
          { debit_amount: 300, credit_amount: 0, journal_entry_id: 'e2' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(1500)
    expect(result.account_1510_balance).toBe(1500)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts posted AND reversed 1510 lines (corrected invoice nets correctly)', async () => {
    // Same fix as supplier-reconciliation: a corrected customer invoice flips its
    // original to status='reversed'. The reversed leg must be summed with the
    // posted storno/correction or a corrected, settled invoice shows a phantom
    // gap against the kundreskontra.
    results = [
      // 0: invoices — single 5 000 SEK invoice still open
      {
        data: [{ total: 5000, paid_amount: 0, currency: 'SEK', exchange_rate: null }],
        error: null,
      },
      // 1: 1510 lines as returned by posted+reversed: original (reversed debit
      //    5000), storno (credit 5000), correction (debit 5000). Net = 5000.
      {
        data: [
          { debit_amount: 5000, credit_amount: 0, journal_entry_id: 'reg-reversed' },
          { debit_amount: 0, credit_amount: 5000, journal_entry_id: 'storno' },
          { debit_amount: 5000, credit_amount: 0, journal_entry_id: 'correction' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(5000)
    expect(result.account_1510_balance).toBe(5000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)

    // Guard the actual fix: the 1510/1513 query must include reversed entries.
    const statusFilter = calls.find(
      (c) => c.method === 'in' && c.args[0] === 'journal_entries.status',
    )
    expect(statusFilter?.args[1]).toEqual(['posted', 'reversed'])
  })

  it('uses Math.round for monetary precision', async () => {
    results = [
      {
        data: [
          { total: 100.1, paid_amount: 33.33 },
        ],
        error: null,
      },
      {
        data: [
          { debit_amount: 66.77, credit_amount: 0, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(66.77)
    expect(result.account_1510_balance).toBe(66.77)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})
