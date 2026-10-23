import { describe, it, expect } from 'vitest'
import {
  liveReceivableOutstanding,
  openSkatteverketShare,
  outstandingLessPayouts,
  skatteverketSettled,
  skatteverketSettledByInvoice,
  type PayoutItemFact,
} from '../skatteverket-share'

// RUT invoice: total 10 000, deduction 3 000 on 1513, customer share 7 000.
const rut = { deduction_total: 3000, deduction_reclaimed_total: 0 }

describe('skatteverketSettled', () => {
  it('is 0 without settled begäran items', () => {
    expect(skatteverketSettled(rut, [])).toBe(0)
  })

  it('counts the whole deduction for a begäran paid in full, öre included', () => {
    // The request asks for whole kronor (2 999), the payout also clears the
    // öre the invoice carried on 1513.
    const withOre = { deduction_total: 2999.6, deduction_reclaimed_total: 0 }
    expect(skatteverketSettled(withOre, [{ request_status: 'paid', decided_amount: 2999 }])).toBe(2999.6)
  })

  it('counts the decided amount of a partly paid begäran', () => {
    expect(skatteverketSettled(rut, [{ request_status: 'partially_paid', decided_amount: 2000 }])).toBe(2000)
  })

  it('reads a missing decided amount as nothing paid', () => {
    expect(skatteverketSettled(rut, [{ request_status: 'partially_paid', decided_amount: null }])).toBe(0)
  })

  it('counts a paid begäran as the deduction not reclaimed', () => {
    const reclaimed = { deduction_total: 3000, deduction_reclaimed_total: 1000 }
    expect(skatteverketSettled(reclaimed, [{ request_status: 'paid', decided_amount: 2000 }])).toBe(2000)
  })

  it('never exceeds the claim when a re-request after a partial payout is paid', () => {
    expect(
      skatteverketSettled(rut, [
        { request_status: 'partially_paid', decided_amount: 2000 },
        { request_status: 'paid', decided_amount: 1000 },
      ])
    ).toBe(3000)
  })

  it('is 0 for an invoice without a deduction', () => {
    expect(skatteverketSettled({ deduction_total: 0 }, [{ request_status: 'paid', decided_amount: 100 }])).toBe(0)
    expect(skatteverketSettled({ deduction_total: null }, [])).toBe(0)
  })
})

describe('openSkatteverketShare', () => {
  it('is the whole deduction while the begäran is unsettled', () => {
    expect(openSkatteverketShare(rut, 0)).toBe(3000)
  })

  it('is 0 once Skatteverket has paid it all', () => {
    expect(openSkatteverketShare(rut, 3000)).toBe(0)
  })

  it('is the refused remainder after a partial payout, until reclaimed', () => {
    expect(openSkatteverketShare(rut, 2000)).toBe(1000)
    expect(openSkatteverketShare({ deduction_total: 3000, deduction_reclaimed_total: 1000 }, 2000)).toBe(0)
  })

  it('leaves out the reclaimed part, which is the customer\'s again', () => {
    expect(openSkatteverketShare({ deduction_total: 3000, deduction_reclaimed_total: 500 }, 0)).toBe(2500)
  })

  it('accepts numeric strings and rounds to the öre', () => {
    expect(openSkatteverketShare({ deduction_total: '1234.56', deduction_reclaimed_total: '0.01' }, 0)).toBe(1234.55)
  })

  it('is 0 without a deduction, and never negative', () => {
    expect(openSkatteverketShare({ deduction_total: 0 }, 0)).toBe(0)
    expect(openSkatteverketShare({ deduction_total: Number.NaN }, 0)).toBe(0)
    expect(openSkatteverketShare(rut, 5000)).toBe(0)
  })
})

describe('outstandingLessPayouts', () => {
  it('returns the outstanding untouched when nothing was paid out', () => {
    expect(outstandingLessPayouts(100.1, undefined)).toBe(100.1)
    expect(outstandingLessPayouts(100.1, 0)).toBe(100.1)
  })

  it('subtracts the payouts', () => {
    expect(outstandingLessPayouts(3000, 2000)).toBe(1000)
  })
})

describe('liveReceivableOutstanding', () => {
  it('reads a paid invoice with a deduction as its open Skatteverket share', () => {
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 3000, undefined)).toBe(3000)
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 3000, 2000)).toBe(1000)
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 3000, 3000)).toBe(0)
  })

  it('ignores paid_amount on a paid invoice with a deduction', () => {
    // total - paid_amount says 0 (paid_amount = total), the claim is still open.
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 0, undefined)).toBe(3000)
  })

  it('subtracts the payouts from an open invoice', () => {
    const reclaimed = { deduction_total: 3000, deduction_reclaimed_total: 1000, status: 'partially_paid' }
    expect(liveReceivableOutstanding(reclaimed, 3000, 2000)).toBe(1000)
  })

  it('leaves an invoice without a deduction exactly as it was', () => {
    expect(liveReceivableOutstanding({ status: 'sent', deduction_total: 0 }, 1234.5, undefined)).toBe(1234.5)
    expect(liveReceivableOutstanding({ status: 'paid', deduction_total: null }, 0, undefined)).toBe(0)
  })
})

describe('skatteverketSettledByInvoice', () => {
  // A begäran item as get_ar_ledger_invoices attaches it to the invoice.
  const item = (status: string, decided: number | null, entryDate: string | null): PayoutItemFact => ({
    request_status: status,
    decided_amount: decided,
    settlement_entry_date: entryDate,
  })

  it('reads nothing for invoices without a deduction', () => {
    const settled = skatteverketSettledByInvoice([
      { id: 'plain', deduction_total: 0, payout_items: [item('paid', 100, '2025-05-10')] },
      { id: 'null', deduction_total: null },
    ])
    expect(settled.size).toBe(0)
  })

  it("sums each invoice's settled items", () => {
    const settled = skatteverketSettledByInvoice([
      { id: 'inv-paid', ...rut, payout_items: [item('paid', 3000, '2025-05-10')] },
      { id: 'inv-part', ...rut, payout_items: [item('partially_paid', 2000, '2025-05-10')] },
      { id: 'inv-open', ...rut, payout_items: [] },
      { id: 'plain', deduction_total: 0, payout_items: null },
    ])

    expect(settled.get('inv-paid')).toBe(3000)
    expect(settled.get('inv-part')).toBe(2000)
    expect(settled.has('inv-open')).toBe(false)
    expect(settled.has('plain')).toBe(false)
  })

  it('counts only payouts dated on or before the as-of date, and none it cannot date', () => {
    const invoice = (entryDate: string | null) => [{ id: 'inv-1', ...rut, payout_items: [item('paid', 3000, entryDate)] }]
    expect(skatteverketSettledByInvoice(invoice('2025-05-10'), '2025-05-09').has('inv-1')).toBe(false)
    expect(skatteverketSettledByInvoice(invoice('2025-05-10'), '2025-05-10').get('inv-1')).toBe(3000)
    expect(skatteverketSettledByInvoice(invoice(null), '2025-05-10').has('inv-1')).toBe(false)
    // Live, every settled item counts.
    expect(skatteverketSettledByInvoice(invoice(null)).get('inv-1')).toBe(3000)
  })
})
