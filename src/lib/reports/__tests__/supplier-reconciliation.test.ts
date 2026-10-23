import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'

// ============================================================
// The register side reads the live leverantörsreskontra population
// (get_supplier_ledger_invoices) through rpc(), answered from `tables` by
// its JS port (tests/reskontra-rpc-port.ts); the ledger side is the booked
// balance the balance sheet reads (closingBalanceOf).
// ============================================================

let tables: ReskontraTables
const { supabase } = createReskontraClient(() => tables)

/** The books; an invoice without an id or a status is an approved one. */
function setBooks(books: ReskontraTables) {
  tables = {
    ...books,
    supplier_invoices: (books.supplier_invoices ?? []).map((row, i) => ({ id: `si-${i + 1}`, status: 'approved', ...row })),
  }
}

vi.mock('../trial-balance', () => ({
  closingBalanceOf: vi.fn(),
}))

import { closingBalanceOf } from '../trial-balance'
import { generateReconciliation } from '../supplier-reconciliation'

/** The booked 2440 balance as credits minus debits (IB included). */
function booked(credit: number, debit = 0) {
  // closingBalanceOf answers debit minus credit, the trial balance's sign.
  vi.mocked(closingBalanceOf).mockResolvedValue(Math.round((debit - credit) * 100) / 100)
}

beforeEach(() => {
  vi.clearAllMocks()
  tables = {}
  booked(0)
})

describe('generateReconciliation', () => {
  it('returns reconciled when supplier total matches account 2440 balance', async () => {
    setBooks({ supplier_invoices: [
        { remaining_amount: 5000 },
        { remaining_amount: 3000 },
      ] })
    booked(10000, 2000)

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Supplier total: 5000 + 3000 = 8000
    expect(result.supplier_ledger_total).toBe(8000)
    // Account 2440 (credit-normal): credits - debits = 10000 - 2000 = 8000
    expect(result.account_2440_balance).toBe(8000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('reads the booked side as the balance sheet does: 2440 of this fiscal year, IB included', async () => {
    setBooks({ supplier_invoices: [] })

    await generateReconciliation(supabase, 'company-1', 'period-1')

    // The accounts_payable role (2440 in the SE pack).
    expect(closingBalanceOf).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', ['2440'])
  })

  it('counts the opening balance carried from earlier years (crm#1296)', async () => {
    // A supplier invoice still open from last year (6 000) and one from this
    // year (2 000). 2440 opens at the 6 000 carried from last year's verifikat
    // and the year's own lines add 2 000: the booked side is the account's UB,
    // 8 000, not the year's 2 000.
    setBooks({ supplier_invoices: [{ remaining_amount: 6000 }, { remaining_amount: 2000 }] })
    booked(8000)

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.account_2440_balance).toBe(8000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('a failed balance read fails the reconciliation instead of reading 0', async () => {
    setBooks({ supplier_invoices: [{ remaining_amount: 1000 }] })
    vi.mocked(closingBalanceOf).mockRejectedValue(new Error('get_trial_balance_aggregates failed'))

    await expect(generateReconciliation(supabase, 'company-1', 'period-1')).rejects.toThrow(
      'get_trial_balance_aggregates failed',
    )
  })

  it('detects mismatch when difference != 0', async () => {
    setBooks({ supplier_invoices: [{ remaining_amount: 5000 }] })
    booked(7000)

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(5000)
    expect(result.account_2440_balance).toBe(7000)
    expect(result.difference).toBe(-2000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns reconciled when both are zero/empty', async () => {
    setBooks({ supplier_invoices: [] })

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('handles a company without supplier invoices gracefully', async () => {
    setBooks({})
    booked(3000)

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(3000)
    expect(result.difference).toBe(-3000)
    expect(result.is_reconciled).toBe(false)
  })

  it('computes credit-normal balance for account 2440 (liability)', async () => {
    setBooks({ supplier_invoices: [] })
    booked(15000, 8000)

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Balance = credits - debits = 15000 - 8000 = 7000
    expect(result.account_2440_balance).toBe(7000)
  })

  it('converts foreign-currency remaining_amount to SEK before reconciliation', async () => {
    // Reproduces the production bug: 225 EUR + 1 000 SEK was reported as 1 225
    // against a 2440 balance of 3 475, flagging a false discrepancy.
    setBooks({ supplier_invoices: [
        { remaining_amount: 225, currency: 'EUR', exchange_rate: 11 },
        { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
      ] })
    // 2440 balance = 3 475 SEK (matches converted ledger total)
    booked(3475)

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
    setBooks({ supplier_invoices: [
        { remaining_amount: 100, currency: 'EUR', exchange_rate: null },
        { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
      ] })
    // 2440 balance reflects only the SEK invoice
    booked(1000)

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

  it('uses Math.round for monetary precision', async () => {
    setBooks({ supplier_invoices: [
        { remaining_amount: 33.33 },
        { remaining_amount: 33.34 },
      ] })
    booked(66.67)

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(66.67)
    expect(result.account_2440_balance).toBe(66.67)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})
