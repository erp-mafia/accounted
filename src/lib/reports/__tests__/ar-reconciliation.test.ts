import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue (the register side), and the booked
// balance the balance sheet reads (closingBalanceOf, the ledger side)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let calls: Array<{ method: string; args: unknown[] }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'or', 'not', 'order', 'range']) {
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

vi.mock('../trial-balance', () => ({
  closingBalanceOf: vi.fn(),
}))

import { closingBalanceOf } from '../trial-balance'
import { generateARReconciliation } from '../ar-reconciliation'

/** The booked 1510 + 1513 balance (debit minus credit, IB included). */
function booked(amount: number) {
  vi.mocked(closingBalanceOf).mockResolvedValue(amount)
}

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  calls = []
  supabase = makeClient()
  booked(0)
})

describe('generateARReconciliation', () => {
  it('only reads fakturor: proformas, delivery notes and quotes are not receivables', async () => {
    results = [{ data: [], error: null }]

    await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(calls).toContainEqual({ method: 'eq', args: ['document_type', 'invoice'] })
  })

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
    ]
    booked(6000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // AR: (5000-2000) + (3000-0) = 6000
    expect(result.ar_ledger_total).toBe(6000)
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('detects difference when AR ledger does not match account 1510', async () => {
    results = [{ data: [{ total: 5000, paid_amount: 0 }], error: null }]
    // The invoice's 5 000 plus a manual 1 000 debit on 1510.
    booked(6000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(5000)
    expect(result.account_1510_balance).toBe(6000)
    expect(result.difference).toBe(-1000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns zero balances when no data exists', async () => {
    results = [{ data: [], error: null }]

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(0)
    expect(result.account_1510_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('handles null invoice data gracefully', async () => {
    results = [{ data: null, error: null }]
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
    results = [{ data: [{ total: 1500, paid_amount: 0, currency: 'SEK', exchange_rate: null }], error: null }]
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
    results = [
      {
        data: [
          { total: 2500, paid_amount: 0 },
          { total: 1500, paid_amount: 0 },
          { total: 1000, paid_amount: 0 },
        ],
        error: null,
      },
    ]
    booked(5000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(5000)
    expect(result.account_1510_balance).toBe(5000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('a failed balance read fails the reconciliation instead of reading 0', async () => {
    results = [{ data: [{ total: 1000, paid_amount: 0 }], error: null }]
    vi.mocked(closingBalanceOf).mockRejectedValue(new Error('get_trial_balance_aggregates failed'))

    await expect(generateARReconciliation(supabase, 'company-1', 'period-1')).rejects.toThrow(
      'get_trial_balance_aggregates failed',
    )
  })

  it('converts foreign-currency outstanding to SEK before reconciliation', async () => {
    results = [
      // 0: invoices: 225 EUR at 11 (with 25 EUR paid) → 200 EUR → 2 200 SEK,
      //    plus 1 000 SEK invoice (no payment)
      {
        data: [
          { total: 225, paid_amount: 25, currency: 'EUR', exchange_rate: 11 },
          { total: 1000, paid_amount: 0, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
    ]
    booked(3200)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(3200)
    expect(result.account_1510_balance).toBe(3200)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    results = [
      // 0: invoices: 100 EUR without rate (excluded), 500 SEK control
      {
        data: [
          { total: 100, paid_amount: 0, currency: 'EUR', exchange_rate: null },
          { total: 500, paid_amount: 0, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
    ]
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
    results = [
      // 0: invoices: 15 625 invoiced, 15 000 paid, 625 open
      {
        data: [{ id: 'inv-pp', total: 15625, paid_amount: 15000, currency: 'SEK', exchange_rate: null }],
        error: null,
      },
    ]
    // 1510: the invoice debit and the partial payment credit
    booked(625)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // The open invoices query filters its population with .or().
    const invoiceStatuses = calls.find((c) => c.method === 'or')?.args[0]
    expect(invoiceStatuses).toContain('partially_paid')
    expect(result.ar_ledger_total).toBe(625)
    expect(result.account_1510_balance).toBe(625)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('uses Math.round for monetary precision', async () => {
    results = [{ data: [{ total: 100.1, paid_amount: 33.33 }], error: null }]
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
    results = [
      // 0: open invoices (the credited original is not in this population)
      {
        data: [
          { id: 'cn', total: -40000, paid_amount: null, currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-cn' },
          { id: 'new', total: 50000, paid_amount: 40000, currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-new' },
        ],
        error: null,
      },
      // 1: the payment row the link wrote on the new invoice
      {
        data: [
          {
            id: 'pay-setoff', invoice_id: 'new', journal_entry_id: 'je-cn', amount: 40000, currency: 'SEK',
            payment_exchange_rate: null, payment_date: '2026-09-10', invoice: { invoice_date: '2026-09-20' },
          },
        ],
        error: null,
      },
    ]
    // 1510: original 40 000, its payment -40 000, the credit note -40 000,
    // the new invoice 50 000.
    booked(10000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(calls).toContainEqual({ method: 'in', args: ['journal_entry_id', ['je-cn']] })
    expect(result.ar_ledger_total).toBe(10000)
    expect(result.account_1510_balance).toBe(10000)
    expect(result.difference).toBe(0)
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
  const item = (status: string, decided: number | null) => ({
    id: `item-${status}`, invoice_id: 'inv-rut', decided_amount: decided,
    request: { status, settlement: { entry_date: '2026-05-10' } },
  })
  // Invoice voucher (1510 7 000, 1513 3 000), the buyer's payment, the plain
  // invoice: 1510 closes at 1 250 and 1513 at what Skatteverket has not paid
  // out (`rest1513`).
  const ledger = (rest1513: number) => booked(1250 + rest1513)

  it('reads paid invoices with a deduction into the population', async () => {
    results = [{ data: [], error: null }]

    await generateARReconciliation(supabase, 'company-1', 'period-1')

    const filter = calls.find((c) => c.method === 'or')?.args[0]
    expect(filter).toBe('status.in.(sent,overdue,partially_paid),and(status.eq.paid,deduction_total.gt.0)')
  })

  it('counts the deduction of a paid invoice whose begäran is not settled', async () => {
    results = [
      { data: [rut, plain], error: null },
      // No settled begäran item.
      { data: [], error: null },
    ]
    ledger(3000)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(calls).toContainEqual({ method: 'in', args: ['invoice_id', ['inv-rut']] })
    expect(result.ar_ledger_total).toBe(4250)
    expect(result.account_1510_balance).toBe(4250)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts nothing once the begäran is settled in full', async () => {
    results = [
      { data: [rut, plain], error: null },
      { data: [item('paid', 3000)], error: null },
    ]
    ledger(0)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(1250)
    expect(result.account_1510_balance).toBe(1250)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts the refused remainder of a partly paid begäran', async () => {
    results = [
      { data: [rut, plain], error: null },
      { data: [item('partially_paid', 2000)], error: null },
    ]
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
    results = [
      { data: [reclaimed, plain], error: null },
      { data: [item('partially_paid', 2000)], error: null },
    ]
    booked(2250)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(2250)
    expect(result.account_1510_balance).toBe(2250)
    expect(result.is_reconciled).toBe(true)
  })

  it('counts nothing for a paid invoice whose reclaimed remainder the buyer has paid', async () => {
    // 1510: the reclaimed 1 000 paid as well, so only the plain invoice is left.
    const settled = { ...rut, paid_amount: 8000, deduction_reclaimed_total: 1000 }
    results = [
      { data: [settled, plain], error: null },
      { data: [item('partially_paid', 2000)], error: null },
    ]
    booked(1250)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.ar_ledger_total).toBe(1250)
    expect(result.account_1510_balance).toBe(1250)
    expect(result.is_reconciled).toBe(true)
  })

  it('reads no begäran items when no invoice has a deduction', async () => {
    results = [{ data: [plain], error: null }]
    booked(1250)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(supabase.from).not.toHaveBeenCalledWith('rot_rut_payout_request_items')
    expect(result.ar_ledger_total).toBe(1250)
    expect(result.is_reconciled).toBe(true)
  })
})
