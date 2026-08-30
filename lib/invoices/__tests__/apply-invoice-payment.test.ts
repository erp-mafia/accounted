import { describe, it, expect } from 'vitest'
import {
  deriveCustomerSettlementAmount,
  planInvoicePayment,
  planInvoicePaymentForLines,
  PAYMENT_OVERSHOOT_TOLERANCE,
} from '@/lib/invoices/apply-invoice-payment'

describe('planInvoicePayment', () => {
  it('marks fully paid on an exact payment', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 0, remaining_amount: 1000 }, 1000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan).toEqual({
        newPaidAmount: 1000,
        newRemaining: 0,
        isFullyPaid: true,
        newStatus: 'paid',
        oreSettled: false,
      })
    }
  })

  it('marks partially paid on a partial payment', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 0, remaining_amount: 1000 }, 400)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('partially_paid')
      expect(r.plan.newPaidAmount).toBe(400)
      expect(r.plan.newRemaining).toBe(600)
      expect(r.plan.isFullyPaid).toBe(false)
    }
  })

  it('accumulates onto an existing paid_amount', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 600, remaining_amount: 400 }, 400)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newPaidAmount).toBe(1000)
      expect(r.plan.isFullyPaid).toBe(true)
    }
  })

  it('REJECTS overpayment (the bug: agent/v1 paths used to swallow it)', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 0, remaining_amount: 1000 }, 1500)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
      expect(r.details).toEqual({
        transaction_amount: 1500,
        remaining_amount: 1000,
        excess: 500,
      })
    }
  })

  it('accepts a sub-öre overshoot (float drift) but rejects a real one-öre over', () => {
    expect(planInvoicePayment({ total: 1000, remaining_amount: 1000 }, 1000.004).ok).toBe(true)
    expect(planInvoicePayment({ total: 1000, remaining_amount: 1000 }, 1000.01).ok).toBe(false)
  })

  it('falls back to total - paid_amount when remaining_amount is absent', () => {
    expect(planInvoicePayment({ total: 1000, paid_amount: 300 }, 700).ok).toBe(true)
    expect(planInvoicePayment({ total: 1000, paid_amount: 300 }, 701).ok).toBe(false)
  })

  it('overshoot tolerance is half an öre', () => {
    expect(PAYMENT_OVERSHOOT_TOLERANCE).toBe(0.005)
  })

  describe('absorbOreRounding', () => {
    it('settles in full when the customer paid the rounded-up "Att betala"', () => {
      // Invoice total 1234.75, PDF shows 1235.00 (öresavrundning), customer pays that.
      const r = planInvoicePayment(
        { total: 1234.75, paid_amount: 0, remaining_amount: 1234.75 },
        1235,
        { absorbOreRounding: true },
      )
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.plan).toEqual({
          newPaidAmount: 1234.75,
          newRemaining: 0,
          isFullyPaid: true,
          newStatus: 'paid',
          oreSettled: true,
        })
      }
    })

    it('settles a sub-krona short payment in full (rounded-down total)', () => {
      const r = planInvoicePayment(
        { total: 1000.4, paid_amount: 0, remaining_amount: 1000.4 },
        1000,
        { absorbOreRounding: true },
      )
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.plan.newStatus).toBe('paid')
        expect(r.plan.newPaidAmount).toBe(1000.4)
        expect(r.plan.newRemaining).toBe(0)
        expect(r.plan.oreSettled).toBe(true)
      }
    })

    it('still rejects an overshoot beyond the öre band', () => {
      const r = planInvoicePayment(
        { total: 1000, paid_amount: 0, remaining_amount: 1000 },
        1001.25,
        { absorbOreRounding: true },
      )
      expect(r.ok).toBe(false)
    })

    it('rejects an overshoot of exactly 1 kr (band boundary must not over-record)', () => {
      const r = planInvoicePayment(
        { total: 1000, paid_amount: 0, remaining_amount: 1000 },
        1001,
        { absorbOreRounding: true },
      )
      expect(r.ok).toBe(false)
    })

    it('a >=1 kr short payment stays a real partial', () => {
      const r = planInvoicePayment(
        { total: 1000, paid_amount: 0, remaining_amount: 1000 },
        999,
        { absorbOreRounding: true },
      )
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.plan.newStatus).toBe('partially_paid')
        expect(r.plan.newRemaining).toBe(1)
        expect(r.plan.oreSettled).toBe(false)
      }
    })

    it('without the opt-in the sub-krona overshoot is still rejected', () => {
      const r = planInvoicePayment(
        { total: 1234.75, paid_amount: 0, remaining_amount: 1234.75 },
        1235,
      )
      expect(r.ok).toBe(false)
    })
  })
})

describe('planInvoicePaymentForLines', () => {
  const INV = { total: 1234.75, paid_amount: 0, remaining_amount: 1234.75 }

  it('absorbs when the lines carry the exact residual on 3740', () => {
    const r = planInvoicePaymentForLines(
      INV,
      1235,
      [
        { account_number: '1930', debit_amount: 1235, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1234.75 },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
      ],
      'SEK',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('paid')
      expect(r.plan.newPaidAmount).toBe(1234.75)
      expect(r.plan.oreSettled).toBe(true)
    }
  })

  it('short-payment lines with a 3740 debit residual settle in full', () => {
    const r = planInvoicePaymentForLines(
      { total: 1000.4, paid_amount: 0, remaining_amount: 1000.4 },
      1000,
      [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1000.4 },
        { account_number: '3740', debit_amount: 0.4, credit_amount: 0 },
      ],
      'SEK',
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.newStatus).toBe('paid')
  })

  it('a sub-krona short WITHOUT a 3740 line stays a real partial (no silent write-off)', () => {
    // Deliberate partial: user lowered both legs; 1510 is only cleared by the
    // paid amount, so flipping to paid would orphan the residual on 1510.
    const r = planInvoicePaymentForLines(
      INV,
      1234,
      [
        { account_number: '1930', debit_amount: 1234, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1234 },
      ],
      'SEK',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('partially_paid')
      expect(r.plan.newRemaining).toBe(0.75)
      expect(r.plan.oreSettled).toBe(false)
    }
  })

  it('a sub-krona overshoot WITHOUT a 3740 line is rejected (1510 would over-credit)', () => {
    const r = planInvoicePaymentForLines(
      INV,
      1235.25,
      [
        { account_number: '1930', debit_amount: 1235.25, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1235.25 },
      ],
      'SEK',
    )
    expect(r.ok).toBe(false)
  })

  it('a 3740 amount that does not match the residual falls back to the strict plan', () => {
    const r = planInvoicePaymentForLines(
      INV,
      1235.25, // 0.50 over, but the lines only book 0.25 on 3740
      [
        { account_number: '1930', debit_amount: 1235.25, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1235 },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
      ],
      'SEK',
    )
    expect(r.ok).toBe(false)
  })

  it('never absorbs for non-SEK invoices', () => {
    const r = planInvoicePaymentForLines(
      { total: 100, paid_amount: 0, remaining_amount: 100 },
      100.25,
      [
        { account_number: '1930', debit_amount: 100.25, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 100 },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
      ],
      'EUR',
    )
    expect(r.ok).toBe(false)
  })

  it('without lines it behaves exactly like the strict plan', () => {
    expect(planInvoicePaymentForLines(INV, 1234.75, undefined, 'SEK').ok).toBe(true)
    expect(planInvoicePaymentForLines(INV, 1235, undefined, 'SEK').ok).toBe(false)
  })
})

describe('deriveCustomerSettlementAmount', () => {
  // The kontantmetoden ROT shape from proposeCashLines: total 124 000,
  // deduction 37 200 (30 %), customer share 86 800.
  const ROT_CASH_LINES = [
    { account_number: '1930', debit_amount: 86800, credit_amount: 0 },
    { account_number: '1513', debit_amount: 37200, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 99200 },
    { account_number: '2611', debit_amount: 0, credit_amount: 24800 },
  ]

  it('excludes the 1513 leg on a ROT invoice (the reported bug)', () => {
    expect(deriveCustomerSettlementAmount(ROT_CASH_LINES, 37200)).toBe(86800)
  })

  it('is the plain debit sum without any 1513 line', () => {
    const lines = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ]
    expect(deriveCustomerSettlementAmount(lines, 0)).toBe(1000)
    expect(deriveCustomerSettlementAmount(lines, 37200)).toBe(1000)
  })

  it('with cap 0 a hand-added 1513 debit still counts as payment (non-ROT unchanged)', () => {
    const lines = [
      { account_number: '1930', debit_amount: 900, credit_amount: 0 },
      { account_number: '1513', debit_amount: 100, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ]
    expect(deriveCustomerSettlementAmount(lines, 0)).toBe(1000)
  })

  it('excludes at most the deduction cap when the 1513 debit overshoots it', () => {
    const lines = [
      { account_number: '1930', debit_amount: 86800, credit_amount: 0 },
      { account_number: '1513', debit_amount: 40000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 102000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 24800 },
    ]
    // Only 37 200 of the 40 000 is deduction; the surplus stays in the amount
    // so the overpayment guard still sees it.
    expect(deriveCustomerSettlementAmount(lines, 37200)).toBe(89600)
  })

  it('nets 1513 debits against 1513 credits before excluding', () => {
    // A self-canceling 1513 debit/credit pair does not raise the exclusion:
    // net 1513 stays 37 200, so the extra 500 debit stays in the settlement
    // amount and the overpayment guard sees it (safe direction: rejects
    // rather than silently excludes).
    const lines = [
      ...ROT_CASH_LINES,
      { account_number: '1513', debit_amount: 500, credit_amount: 0 },
      { account_number: '1513', debit_amount: 0, credit_amount: 500 },
    ]
    expect(deriveCustomerSettlementAmount(lines, 37200)).toBe(87300)
  })

  it('a net 1513 credit is not added to the settlement', () => {
    const lines = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1513', debit_amount: 0, credit_amount: 200 },
      { account_number: '1510', debit_amount: 0, credit_amount: 800 },
    ]
    expect(deriveCustomerSettlementAmount(lines, 37200)).toBe(1000)
  })

  it('leaves 3740 öre legs untouched and rounds float sums', () => {
    const lines = [
      { account_number: '1930', debit_amount: 86800.4, credit_amount: 0 },
      { account_number: '1513', debit_amount: 37200, credit_amount: 0 },
      { account_number: '3740', debit_amount: 0.1, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 99200.5 },
      { account_number: '2611', debit_amount: 0, credit_amount: 24800 },
    ]
    expect(deriveCustomerSettlementAmount(lines, 37200)).toBe(86800.5)
  })
})
