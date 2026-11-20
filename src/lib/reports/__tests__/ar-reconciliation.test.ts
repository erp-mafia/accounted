import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'

// ============================================================
// The register side reads the live kundreskontra population
// (get_ar_ledger_invoices) and the coverage probe through rpc(), answered
// from `tables` by their JS ports (tests/reskontra-rpc-port.ts); the ledger
// side is the booked balance the balance sheet reads (closingBalanceOf).
// ============================================================

let tables: ReskontraTables
const { supabase, calls } = createReskontraClient(() => tables)

/** The books; an invoice without an id or a status is an open ('sent') one. */
function setBooks(books: ReskontraTables) {
  tables = {
    ...books,
    invoices: (books.invoices ?? []).map((row, i) => ({ id: `inv-${i + 1}`, status: 'sent', due_date: '2026-01-31', ...row })),
  }
}

vi.mock('../trial-balance', () => ({
  closingBalanceOf: vi.fn(),
}))

import { closingBalanceOf } from '../trial-balance'
import { generateARReconciliation } from '../ar-reconciliation'
import { generateARLedger } from '../ar-ledger'

/** The booked 1510 + 1513 balance (debit minus credit, IB included). */
function booked(amount: number) {
  vi.mocked(closingBalanceOf).mockResolvedValue(amount)
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  tables = {}
  booked(0)
})

describe('generateARReconciliation', () => {
  it('only reads fakturor: proformas, delivery notes and quotes are not receivables', async () => {
    setBooks({
      invoices: [
        { total: 1000, paid_amount: 0 },
        { total: 900, paid_amount: 0, document_type: 'proforma' },
        { total: 800, paid_amount: 0, document_type: 'quote' },
      ],
    })
    booked(1000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // The live population: no as-of date.
    expect(calls.find((c) => c.name === 'get_ar_ledger_invoices')?.args).toEqual({
      p_company_id: 'company-1',
      p_as_of_date: null,
      p_customer_id: null,
    })
    expect(result.ar_ledger_total).toBe(1000)
    expect(result.is_reconciled).toBe(true)
  })

  it('returns reconciled when AR ledger matches account 1510', async () => {
    setBooks({ invoices: [
        { total: 5000, paid_amount: 2000 },
        { total: 3000, paid_amount: 0 },
      ] })
    booked(6000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // AR: (5000-2000) + (3000-0) = 6000
    expect(result.ar_ledger_total).toBe(6000)
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('detects difference when AR ledger does not match account 1510', async () => {
    setBooks({ invoices: [{ total: 5000, paid_amount: 0 }] })
    // The invoice's 5 000 plus a manual 1 000 debit on 1510.
    booked(6000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(5000)
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(-1000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns zero balances when no data exists', async () => {
    setBooks({ invoices: [] })

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(0)
    expect(result.account_1510_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('handles a company without invoices gracefully', async () => {
    setBooks({})
    booked(3000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(0)
    expect(result.account_1510_balance).toBe(3000)
    expect(result.difference).toBe(-3000)
    expect(result.is_reconciled).toBe(false)
  })

  it('reads the booked side as the balance sheet does: 1510 and 1513 of this fiscal year, IB included', async () => {
    // A fakturamodellen invoice splits the AR receivable across 1510
    // (customer portion) and 1513 (Skatteverket claim): both are read, by
    // account role (accounts_receivable and rot_rut_receivable in the SE pack).
    setBooks({ invoices: [{ total: 1500, paid_amount: 0, currency: 'SEK', exchange_rate: null }] })
    booked(1500)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(closingBalanceOf).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', ['1510', '1513'])
    expect(result.account_1510_balance).toBe(1500)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts the opening balance carried from earlier years (crm#1296)', async () => {
    // Two invoices still open from last year (4 000) and one from this year
    // (1 000). 1510 opens at the 4 000 carried from last year's verifikat and
    // the year's own lines add 1 000: the booked side is the account's UB,
    // 5 000, not the year's 1 000.
    setBooks({ invoices: [
        { total: 2500, paid_amount: 0 },
        { total: 1500, paid_amount: 0 },
        { total: 1000, paid_amount: 0 },
      ] })
    booked(5000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(5000)
    expect(result.account_1510_balance).toBe(5000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('a failed balance read fails the reconciliation instead of reading 0', async () => {
    setBooks({ invoices: [{ total: 1000, paid_amount: 0 }] })
    vi.mocked(closingBalanceOf).mockRejectedValue(new Error('get_trial_balance_aggregates failed'))

    await expect(generateARReconciliation(supabase, 'company-1', 'period-1')).rejects.toThrow(
      'get_trial_balance_aggregates failed',
    )
  })

  it('converts foreign-currency outstanding to SEK before reconciliation', async () => {
    setBooks({ invoices: [
        { total: 225, paid_amount: 25, currency: 'EUR', exchange_rate: 11 },
        { total: 1000, paid_amount: 0, currency: 'SEK', exchange_rate: null },
      ] })
    booked(3200)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(3200)
    expect(result.account_1510_balance).toBe(3200)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    setBooks({ invoices: [
        { total: 100, paid_amount: 0, currency: 'EUR', exchange_rate: null },
        { total: 500, paid_amount: 0, currency: 'SEK', exchange_rate: null },
      ] })
    // 1510 balance reflects only the SEK invoice
    booked(500)

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

  it('includes partially paid invoices: their remainder is still on 1510 (feedback seq 817399)', async () => {
    setBooks({ invoices: [{ id: 'inv-pp', total: 15625, paid_amount: 15000, currency: 'SEK', exchange_rate: null }] })
    // 1510: the invoice debit and the partial payment credit
    booked(625)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(625)
    expect(result.account_1510_balance).toBe(625)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('uses Math.round for monetary precision', async () => {
    setBooks({ invoices: [{ total: 100.1, paid_amount: 33.33 }] })
    booked(66.77)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(66.77)
    expect(result.account_1510_balance).toBe(66.77)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})

describe('generateARReconciliation: a credit note set off against a new invoice (crm#1059)', () => {
  // A paid invoice credited in full (40 000 back to the customer on 1510),
  // then that credit linked as the payment of a new 50 000 invoice: the
  // credit note's own verifikat is the new invoice's payment row.
  it('counts the used credit once, so the kundreskontra ties out against 1510', async () => {
    setBooks({
      invoices: [
        { id: 'cn', total: -40000, paid_amount: null, currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-cn' },
        { id: 'new', total: 50000, paid_amount: 40000, currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-new' },
      ],
      invoice_payments: [
        {
          id: 'pay-setoff', invoice_id: 'new', journal_entry_id: 'je-cn', amount: 40000, currency: 'SEK',
          payment_exchange_rate: null, payment_date: '2026-09-10', invoice: { invoice_date: '2026-09-20' },
        },
      ],
    })
    // 1510: original 40 000, its payment -40 000, the credit note -40 000,
    // the new invoice 50 000.
    booked(10000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(10000)
    expect(result.account_1510_balance).toBe(10000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })
})

describe('generateARReconciliation: a credited invoice and its credit note (crm#1537)', () => {
  // Kreditera books the credit note's own verifikat (Cr 1510) and moves the
  // original to 'credited'; the credit note stays 'sent'. 1510 nets the pair.
  const original = {
    id: 'inv-original', customer_id: 'cust-a', total: 50000, paid_amount: 0, status: 'credited',
    currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-original',
    invoice_date: '2026-08-01', due_date: '2026-08-31',
  }
  const creditNote = {
    id: 'inv-credit-note', customer_id: 'cust-a', total: -50000, paid_amount: 0, status: 'sent',
    currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-credit-note',
    invoice_date: '2026-08-15', due_date: '2026-08-15',
  }
  const open = {
    id: 'inv-open', customer_id: 'cust-b', total: 20000, paid_amount: 0, status: 'sent',
    currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-open',
    invoice_date: '2026-09-01', due_date: '2026-09-30',
  }

  it('counts the credited original beside its credit note, so the pair nets to nothing', async () => {
    setBooks({ invoices: [original, creditNote, open] })
    // 1510: the original 50 000, its credit note -50 000, the open invoice 20 000.
    booked(20000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(20000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('sums exactly what the kundreskontra sums: one definition of the open amount', async () => {
    setBooks({ invoices: [original, creditNote, open] })
    booked(20000)

    const [reconciliation, ledger] = await Promise.all([
      generateARReconciliation(supabase, 'company-1', 'period-1'),
      generateARLedger(supabase, 'company-1'),
    ])

    expect(reconciliation.ar_ledger_total).toBe(ledger.total_outstanding)
  })

  it('a paid invoice credited afterwards leaves the credit open as money owed back', async () => {
    // 1510: the original 50 000, its payment -50 000, the credit note -50 000:
    // 50 000 owed back to the customer until it is refunded or set off.
    setBooks({ invoices: [{ ...original, paid_amount: 50000 }, creditNote] })
    booked(-50000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(-50000)
    expect(result.is_reconciled).toBe(true)
  })

  it('a migrated settled credit note stays out, as in the kundreskontra', async () => {
    // The provider netted the credit into the original's paid_amount and the
    // migration imported the credit note as 'credited' with a negative total.
    setBooks({
      invoices: [
        { ...original, status: 'paid', paid_amount: 50000 },
        { ...creditNote, status: 'credited' },
        open,
      ],
    })
    booked(20000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(20000)
    expect(result.is_reconciled).toBe(true)
  })
})

describe('generateARReconciliation: ROT/RUT invoices awaiting Skatteverket', () => {
  // RUT invoice: 10 000 invoiced, deduction 3 000 on 1513, the buyer's 7 000
  // paid. The invoice is 'paid' while Skatteverket's 3 000 is still open.
  const rut = {
    id: 'inv-rut', total: 10000, paid_amount: 7000, deduction_total: 3000, deduction_reclaimed_total: 0,
    currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-rut', status: 'paid',
  }
  const plain = {
    id: 'inv-plain', total: 1250, paid_amount: 0, deduction_total: 0, deduction_reclaimed_total: 0,
    currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-plain', status: 'sent',
  }
  // One begäran item for the invoice, on a begäran settled by the payout
  // voucher of 2026-05-10.
  const item = (status: string, decided: number | null): ReskontraTables => ({
    rot_rut_payout_request_items: [{ id: `item-${status}`, invoice_id: 'inv-rut', request_id: `req-${status}`, decided_amount: decided }],
    rot_rut_payout_requests: [{ id: `req-${status}`, status, settlement_journal_entry_id: 'je-payout' }],
    journal_entries: [{ id: 'je-payout', entry_date: '2026-05-10', status: 'posted' }],
  })
  // Invoice voucher (1510 7 000, 1513 3 000), the buyer's payment, the plain
  // invoice: 1510 closes at 1 250 and 1513 at what Skatteverket has not paid
  // out (`rest1513`).
  const ledger = (rest1513: number) => booked(1250 + rest1513)

  it('reads paid invoices with a deduction into the population; a credited original nets against its credit note', async () => {
    // A credited original and its credit note are both on 1510 and net to
    // nothing; a paid invoice without a deduction is settled.
    setBooks({
      invoices: [
        rut,
        { ...plain, id: 'inv-credited', status: 'credited' },
        { ...plain, id: 'inv-credit-note', total: -1250, journal_entry_id: 'je-credit-note' },
        { ...plain, id: 'inv-paid', status: 'paid', paid_amount: 1250 },
      ],
    })
    ledger(3000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(3000)
    expect(result.is_reconciled).toBe(false)
  })

  it('counts the deduction of a paid invoice whose begäran is not settled', async () => {
    setBooks({ invoices: [rut, plain] })
    ledger(3000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(4250)
    expect(result.account_1510_balance).toBe(4250)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts nothing once the begäran is settled in full', async () => {
    setBooks({ invoices: [rut, plain], ...item('paid', 3000) })
    ledger(0)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(1250)
    expect(result.account_1510_balance).toBe(1250)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts the refused remainder of a partly paid begäran', async () => {
    setBooks({ invoices: [rut, plain], ...item('partially_paid', 2000) })
    ledger(1000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(2250)
    expect(result.account_1510_balance).toBe(2250)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts a reclaimed remainder once, as the buyer\'s again', async () => {
    // The refused 1 000 moved onto the buyer (debit 1510 / credit 1513): the
    // invoice is partially_paid again and owes it as total - paid - payout.
    // 1510: 7 000 - 7 000 + 1 000 + 1 250; 1513: 3 000 - 2 000 - 1 000.
    const reclaimed = { ...rut, deduction_reclaimed_total: 1000, status: 'partially_paid' }
    setBooks({ invoices: [reclaimed, plain], ...item('partially_paid', 2000) })
    booked(2250)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(2250)
    expect(result.account_1510_balance).toBe(2250)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts nothing for a paid invoice whose reclaimed remainder the buyer has paid', async () => {
    // 1510: the reclaimed 1 000 paid as well, so only the plain invoice is left.
    const settled = { ...rut, paid_amount: 8000, deduction_reclaimed_total: 1000 }
    setBooks({ invoices: [settled, plain], ...item('partially_paid', 2000) })
    booked(1250)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(1250)
    expect(result.account_1510_balance).toBe(1250)
    expect(result.is_reconciled).toBe(true)
  })

  it('reads no begäran items when no invoice has a deduction', async () => {
    setBooks({ invoices: [plain] })
    booked(1250)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(1250)
    expect(result.is_reconciled).toBe(true)
  })
})

describe('generateARReconciliation: the reskontra on the year\'s balansdag', () => {
  // Year 2025, UB 500. Invoice B 500 kr, open at year end, paid in January.
  // Invoice A 1 000 kr dated after the year: open today, nothing to do with it.
  const twoYears = (): ReskontraTables => ({
    fiscal_periods: [{ id: 'fy2025', period_end: '2025-12-31' }],
    invoices: [
      { id: 'b', invoice_number: 'B', invoice_date: '2025-11-01', due_date: '2025-12-01', status: 'paid', total: 500, paid_amount: 500, paid_at: '2026-01-10' },
      { id: 'a', invoice_number: 'A', invoice_date: '2026-01-15', due_date: '2026-02-15', status: 'sent', total: 1000, paid_amount: 0 },
    ],
    invoice_payments: [{ id: 'p1', invoice_id: 'b', payment_date: '2026-01-10', amount: 500 }],
  })

  it('reads the invoices open on the last day of a past year, not the ones open today', async () => {
    setBooks(twoYears())
    booked(500)

    const result = await generateARReconciliation(supabase, 'company-1', 'fy2025')

    expect(result).toMatchObject({ as_of_date: '2025-12-31', ar_ledger_total: 500, difference: 0, is_reconciled: true })
  })

  it('is the figure the ledger shows for that day', async () => {
    setBooks(twoYears())
    booked(500)

    const [card, ledger] = await Promise.all([
      generateARReconciliation(supabase, 'company-1', 'fy2025'),
      generateARLedger(supabase, 'company-1', '2025-12-31'),
    ])

    expect(card.ar_ledger_total).toBe(ledger.total_outstanding)
  })

  it('reads the live register while the year runs', async () => {
    setBooks({
      fiscal_periods: [{ id: 'running', period_end: '2999-12-31' }],
      invoices: [{ total: 1000, paid_amount: 0 }],
    })
    booked(1000)

    const result = await generateARReconciliation(supabase, 'company-1', 'running')

    expect(calls.find((c) => c.name === 'get_ar_ledger_invoices')?.args).toMatchObject({ p_as_of_date: null })
    expect(result).toMatchObject({ ar_ledger_total: 1000, is_reconciled: true })
  })
})
