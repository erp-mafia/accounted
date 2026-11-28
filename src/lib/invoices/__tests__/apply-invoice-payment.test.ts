import { describe, it, expect } from 'vitest'
import {
  deriveCustomerSettlementAmount,
  paidLinesOreLeft,
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

  it('the issue verifikat booked the öresavrundning: lines clearing what 1510 carries, with no 3740, settle in full (crm#1553)', () => {
    const lines = [
      { account_number: '1930', debit_amount: 1235, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1235 },
    ]
    const r = planInvoicePaymentForLines(INV, 1235, lines, 'SEK', 1235)
    expect(r.ok && r.plan.newStatus).toBe('paid')
    expect(r.ok && r.plan.newRemaining).toBe(0)
    // Without the ledger figure the same lines are a sub-krona overshoot, refused.
    expect(planInvoicePaymentForLines(INV, 1235, lines, 'SEK').ok).toBe(false)
  })

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

  describe('the issue verifikat booked the öresavrundning: a settlement in full clears what 1510 carries', () => {
    // 999,75 issued as Dr 1510 1 000 / Cr 3740 0,25: 1510 carries 1 000.
    const UP = { total: 999.75, paid_amount: 0, remaining_amount: 999.75 }
    // 1 000,40 issued as Dr 1510 1 000 / Dr 3740 0,40: 1510 carries 1 000.
    const DOWN = { total: 1000.4, paid_amount: 0, remaining_amount: 1000.4 }
    const row = (account_number: string, debit_amount: number, credit_amount: number) => ({
      account_number,
      debit_amount,
      credit_amount,
    })

    it('refuses lines that clear only the reskontra figure (0,25 would stay on 1510)', () => {
      const r = planInvoicePaymentForLines(UP, 999.75, [row('1930', 999.75, 0), row('1510', 0, 999.75)], 'SEK', 1000)
      expect(r).toEqual({
        ok: false,
        code: 'INVOICE_PAID_ORE_LEFT',
        details: { carried: 1000, cleared: 999.75, left: 0.25 },
      })
    })

    it('refuses any other figure inside the öre band of what 1510 carries', () => {
      const r = planInvoicePaymentForLines(
        UP,
        999.75,
        [row('1930', 999.75, 0), row('1510', 0, 999.7), row('3740', 0, 0.05)],
        'SEK',
        1000,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('INVOICE_PAID_ORE_LEFT')
    })

    it('rounded down: refuses lines that credit 1510 the öre total, booking the 3740 öre a second time', () => {
      const exact = planInvoicePaymentForLines(DOWN, 1000.4, [row('1930', 1000.4, 0), row('1510', 0, 1000.4)], 'SEK', 1000)
      expect(exact).toEqual({
        ok: false,
        code: 'INVOICE_PAID_ORE_LEFT',
        details: { carried: 1000, cleared: 1000.4, left: -0.4 },
      })
      const twice = planInvoicePaymentForLines(
        DOWN,
        1000.4,
        [row('1930', 1000, 0), row('3740', 0.4, 0), row('1510', 0, 1000.4)],
        'SEK',
        1000,
      )
      expect(twice.ok).toBe(false)
      if (!twice.ok) expect(twice.code).toBe('INVOICE_PAID_ORE_LEFT')
    })

    it('lines that clear what 1510 carries settle in full, whatever reached the bank', () => {
      const rounded = planInvoicePaymentForLines(UP, 1000, [row('1930', 1000, 0), row('1510', 0, 1000)], 'SEK', 1000)
      expect(rounded.ok && rounded.plan.newStatus).toBe('paid')
      // The customer paid the exact total, not "Att betala": 3740 takes the öre
      // back. The doors pay what the rows debit, 3740 included (1 000).
      const exactRows = [row('1930', 999.75, 0), row('3740', 0.25, 0), row('1510', 0, 1000)]
      for (const paid of [1000, 999.75]) {
        const exactTotal = planInvoicePaymentForLines(UP, paid, exactRows, 'SEK', 1000)
        expect(exactTotal.ok && exactTotal.plan.newStatus).toBe('paid')
        expect(exactTotal.ok && exactTotal.plan.newPaidAmount).toBe(999.75)
        expect(exactTotal.ok && exactTotal.plan.newRemaining).toBe(0)
      }
      // Rounded down, the exact total paid: 3740 gives the 0,40 back.
      const downExact = planInvoicePaymentForLines(
        DOWN,
        1000.4,
        [row('1930', 1000.4, 0), row('1510', 0, 1000), row('3740', 0, 0.4)],
        'SEK',
        1000,
      )
      expect(downExact.ok && downExact.plan.newStatus).toBe('paid')
      const down = planInvoicePaymentForLines(DOWN, 1000, [row('1930', 1000, 0), row('1510', 0, 1000)], 'SEK', 1000)
      expect(down.ok && down.plan.newStatus).toBe('paid')
    })

    it('a part payment is planned as before: the last payment clears the rest of what 1510 carries', () => {
      const r = planInvoicePaymentForLines(UP, 500, [row('1930', 500, 0), row('1510', 0, 500)], 'SEK', 1000)
      expect(r.ok && r.plan.newStatus).toBe('partially_paid')
      expect(r.ok && r.plan.newRemaining).toBe(499.75)
      // Then 499,75 owed and 500 on 1510: the rows the payment dialog proposes
      // (bank the remaining, 1510 what it carries, 3740 the öre) settle it.
      const rest = { total: 999.75, paid_amount: 500, remaining_amount: 499.75 }
      const last = planInvoicePaymentForLines(
        rest,
        500,
        [row('1930', 499.75, 0), row('1510', 0, 500), row('3740', 0.25, 0)],
        'SEK',
        500,
      )
      expect(last.ok && last.plan).toMatchObject({ newStatus: 'paid', newPaidAmount: 999.75, newRemaining: 0 })
      const short = planInvoicePaymentForLines(rest, 499.75, [row('1930', 499.75, 0), row('1510', 0, 499.75)], 'SEK', 500)
      expect(short).toMatchObject({ ok: false, code: 'INVOICE_PAID_ORE_LEFT', details: { carried: 500, cleared: 499.75, left: 0.25 } })
    })

    it('lines that clear what 1510 carries but pay a krona or more off the remainder are planned as before', () => {
      const over = planInvoicePaymentForLines(
        UP,
        1500,
        [row('1930', 1500, 0), row('1510', 0, 1000), row('2420', 0, 500)],
        'SEK',
        1000,
      )
      expect(over).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    })

    it('a krona or more on 3740 is not öresavrundning, and is refused as before', () => {
      const r = planInvoicePaymentForLines(
        UP,
        1000,
        [row('1930', 1, 0), row('3740', 999, 0), row('1510', 0, 1000)],
        'SEK',
        1000,
      )
      expect(r).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    })

    it('1513, Skatteverket\'s share, is not what the customer clears', () => {
      const r = planInvoicePaymentForLines(
        UP,
        999.75,
        [row('1930', 999.75, 0), row('1513', 0, 0.25), row('1510', 0, 999.75)],
        'SEK',
        1000,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('INVOICE_PAID_ORE_LEFT')
    })

    it('an invoice whose 1510 carries its remainder (no ledger figure) is planned exactly as before', () => {
      const r = planInvoicePaymentForLines(UP, 999.75, [row('1930', 999.75, 0), row('1510', 0, 999.75)], 'SEK', null)
      expect(r.ok && r.plan.newStatus).toBe('paid')
      const same = planInvoicePaymentForLines(UP, 999.75, [row('1930', 999.75, 0), row('1510', 0, 999.75)], 'SEK', 999.75)
      expect(same.ok && same.plan.newStatus).toBe('paid')
    })

    it('a gap of a krona or more is not rounding and is planned as before', () => {
      const r = planInvoicePaymentForLines(
        UP,
        999.75,
        [row('1930', 999.75, 0), row('1510', 0, 998.75), row('3010', 0, 1)],
        'SEK',
        1000,
      )
      expect(r.ok && r.plan.newStatus).toBe('paid')
    })
  })
})

describe('paidLinesOreLeft', () => {
  const UP = { total: 999.75, paid_amount: 0, remaining_amount: 999.75 }
  const DOWN = { total: 1000.4, paid_amount: 0, remaining_amount: 1000.4 }
  const row = (account_number: string, debit_amount: number, credit_amount: number) => ({
    account_number,
    debit_amount,
    credit_amount,
  })

  it('rows at the reskontra figure leave the öre the issue verifikat put on 1510', () => {
    expect(paidLinesOreLeft(UP, [row('1930', 1000, 0), row('1510', 0, 999.75), row('3740', 0, 0.25)], 'SEK', 1000)).toEqual({
      carried: 1000,
      cleared: 999.75,
      left: 0.25,
    })
    expect(paidLinesOreLeft(DOWN, [row('1930', 1000, 0), row('3740', 0.4, 0), row('1510', 0, 1000.4)], 'SEK', 1000)).toEqual({
      carried: 1000,
      cleared: 1000.4,
      left: -0.4,
    })
  })

  it('rows that clear what 1510 carries leave nothing, whatever reached the bank', () => {
    expect(paidLinesOreLeft(UP, [row('1930', 1000, 0), row('1510', 0, 1000)], 'SEK', 1000)).toBeNull()
    expect(paidLinesOreLeft(UP, [row('1930', 999.75, 0), row('3740', 0.25, 0), row('1510', 0, 1000)], 'SEK', 1000)).toBeNull()
  })

  it('sums what each row stores, to the öre, not the raw amounts', () => {
    // 333,334 x 3 reads 1 000 raw; journal_entry_lines stores 333,33 x 3.
    const rows = [row('1930', 1000, 0), row('1510', 0, 333.334), row('1510', 0, 333.334), row('1510', 0, 333.332), row('3740', 0, 0.01)]
    expect(paidLinesOreLeft(UP, rows, 'SEK', 1000)).toEqual({ carried: 1000, cleared: 999.99, left: 0.01 })
  })

  it('1513 is Skatteverket\'s share, never what the rows clear for the customer', () => {
    expect(paidLinesOreLeft(UP, [row('1930', 1000.25, 0), row('1510', 0, 1000), row('1513', 0, 0.25)], 'SEK', 1000)).toBeNull()
  })

  it('answers nothing when 1510 carries the remainder, the ledger cannot say, or the invoice is foreign', () => {
    const rows = [row('1930', 1000, 0), row('1510', 0, 999.75), row('3740', 0, 0.25)]
    expect(paidLinesOreLeft(UP, rows, 'SEK', 999.75)).toBeNull()
    expect(paidLinesOreLeft(UP, rows, 'SEK', null)).toBeNull()
    expect(paidLinesOreLeft(UP, rows, 'EUR', 1000)).toBeNull()
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
