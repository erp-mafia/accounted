import { describe, expect, it } from 'vitest'
import {
  customerInvoiceIneligibility,
  planSetoff,
  setoffDefaultAmount,
  supplierInvoiceIneligibility,
  type SetoffInvoiceFacts,
  type SetoffSupplierInvoiceFacts,
} from '../plan'
import { setoffPreview } from '../book'

const PARTY = 'party-exempel-energi'

/** The July case: a customer invoice of 1 388 kr and a self-billed supplier invoice of 4 504 kr. */
function invoice(over: Partial<SetoffInvoiceFacts> = {}): SetoffInvoiceFacts {
  return {
    id: 'inv-1',
    number: '2631',
    status: 'sent',
    documentType: 'invoice',
    creditedInvoiceId: null,
    currency: 'SEK',
    total: 1388,
    remaining: 1388,
    paid: 0,
    deductionTotal: 0,
    invoiceDate: '2026-08-31',
    dueDate: '2026-09-10',
    booked: true,
    partyId: PARTY,
    collectionOpen: false,
    ...over,
  }
}

function supplierInvoice(over: Partial<SetoffSupplierInvoiceFacts> = {}): SetoffSupplierInvoiceFacts {
  return {
    id: 'si-1',
    number: 'SF-CE-202607',
    arrivalNumber: 41,
    status: 'registered',
    isCreditNote: false,
    currency: 'SEK',
    total: 4504,
    remaining: 4504,
    paid: 0,
    invoiceDate: '2026-09-11',
    dueDate: '2026-10-11',
    booked: true,
    partyId: PARTY,
    paymentInFlight: false,
    ...over,
  }
}

const TODAY = '2026-10-21'

describe('planSetoff', () => {
  it("sets off the July invoices: the customer invoice is paid and we pay the 3 116 kr net", () => {
    const result = planSetoff({ invoice: invoice(), supplierInvoice: supplierInvoice(), setoffDate: '2026-09-30', today: TODAY })
    expect(result).toEqual({
      ok: true,
      plan: {
        amount: 1388,
        setoffDate: '2026-09-30',
        partyId: PARTY,
        invoice: { id: 'inv-1', number: '2631', remainingBefore: 1388, remainingAfter: 0, statusAfter: 'paid', applied: 1388, receivableCleared: 1388, oreRounding: 0 },
        supplierInvoice: {
          id: 'si-1',
          number: 'SF-CE-202607',
          arrivalNumber: 41,
          remainingBefore: 4504,
          remainingAfter: 3116,
          statusAfter: 'partially_paid',
        },
        net: { direction: 'we_pay', amount: 3116 },
      },
    })
  })

  it('takes the smaller remaining amount by default, either side', () => {
    expect(setoffDefaultAmount({ remaining: 1388 }, { remaining: 4504 })).toBe(1388)
    expect(setoffDefaultAmount({ remaining: 5000.5 }, { remaining: 4504.25 })).toBe(4504.25)
    const plan = planSetoff({ invoice: invoice({ remaining: 5000 }), supplierInvoice: supplierInvoice(), setoffDate: TODAY, today: TODAY })
    expect(plan.ok && plan.plan.net).toEqual({ direction: 'they_pay', amount: 496 })
    expect(plan.ok && plan.plan.supplierInvoice.statusAfter).toBe('paid')
  })

  it('settles both when the remaining amounts are equal', () => {
    const plan = planSetoff({ invoice: invoice({ remaining: 4504 }), supplierInvoice: supplierInvoice(), setoffDate: TODAY, today: TODAY })
    expect(plan.ok && plan.plan.net).toEqual({ direction: 'settled', amount: 0 })
  })

  it('takes a partial amount, exact to the öre', () => {
    const plan = planSetoff({ invoice: invoice(), supplierInvoice: supplierInvoice(), amount: 1000.55, setoffDate: TODAY, today: TODAY })
    expect(plan.ok && plan.plan.invoice.remainingAfter).toBe(387.45)
    expect(plan.ok && plan.plan.supplierInvoice.remainingAfter).toBe(3503.45)
    expect(plan.ok && plan.plan.invoice.statusAfter).toBe('partially_paid')
  })

  it('refuses an amount that is zero, negative, not whole öre or above either remaining amount', () => {
    const base = { invoice: invoice(), supplierInvoice: supplierInvoice(), setoffDate: TODAY, today: TODAY }
    expect(planSetoff({ ...base, amount: 0 })).toMatchObject({ ok: false, code: 'SETOFF_INVALID_AMOUNT' })
    expect(planSetoff({ ...base, amount: -1 })).toMatchObject({ ok: false, code: 'SETOFF_INVALID_AMOUNT' })
    expect(planSetoff({ ...base, amount: 10.005 })).toMatchObject({ ok: false, code: 'SETOFF_INVALID_AMOUNT' })
    expect(planSetoff({ ...base, amount: 1389 })).toMatchObject({ ok: false, code: 'SETOFF_AMOUNT_EXCEEDS_REMAINING' })
    expect(planSetoff({ ...base, amount: 4504.01, invoice: invoice({ remaining: 5000 }) })).toMatchObject({
      ok: false,
      code: 'SETOFF_AMOUNT_EXCEEDS_REMAINING',
    })
  })

  // crm#1644: the set-off books öresavrundning by the rule every payment of a
  // SEK invoice books by (oreSettlementResidual).
  it('settles an invoice rounded down when its rounded Att betala is set off: the öre on 3740 and the right net', () => {
    const plan = planSetoff({
      invoice: invoice({ total: 3136.18, remaining: 3136.18 }),
      supplierInvoice: supplierInvoice({ total: 4012.13, remaining: 4012.13 }),
      amount: 3136,
      setoffDate: TODAY,
      today: TODAY,
    })
    expect(plan.ok && plan.plan.invoice).toMatchObject({ remainingAfter: 0, statusAfter: 'paid', applied: 3136.18, oreRounding: 0.18 })
    expect(plan.ok && plan.plan.supplierInvoice.remainingAfter).toBe(876.13)
    expect(plan.ok && plan.plan.net).toEqual({ direction: 'we_pay', amount: 876.13 })
  })

  it('settles an invoice rounded up when its rounded Att betala is set off, though it is above the remaining amount', () => {
    const plan = planSetoff({
      invoice: invoice({ total: 3135.82, remaining: 3135.82 }),
      supplierInvoice: supplierInvoice({ total: 4012.13, remaining: 4012.13 }),
      amount: 3136,
      setoffDate: TODAY,
      today: TODAY,
    })
    expect(plan.ok && plan.plan.invoice).toMatchObject({ remainingAfter: 0, statusAfter: 'paid', applied: 3135.82, oreRounding: -0.18 })
    expect(plan.ok && plan.plan.net).toEqual({ direction: 'we_pay', amount: 876.13 })
  })

  it('leaves a gap of a krona or more open, and sets off the exact remaining amount without rounding', () => {
    const base = { supplierInvoice: supplierInvoice(), setoffDate: TODAY, today: TODAY }
    const partial = planSetoff({ ...base, invoice: invoice(), amount: 1387 })
    expect(partial.ok && partial.plan.invoice).toMatchObject({ remainingAfter: 1, statusAfter: 'partially_paid', applied: 1387, oreRounding: 0 })
    const exact = planSetoff({ ...base, invoice: invoice({ total: 3136.18, remaining: 3136.18 }) })
    expect(exact.ok && exact.plan.invoice).toMatchObject({ remainingAfter: 0, applied: 3136.18, oreRounding: 0 })
    expect(exact.ok && exact.plan.amount).toBe(3136.18)
  })

  // The issue verifikat booked the öresavrundning (1510 at the rounded "Att
  // betala", the öre on 3740): a set-off in full clears what 1510 carries and
  // books on 3740 only the rest, as book_counterparty_setoff does.
  it('clears what 1510 carries when the issue verifikat booked the öre, and books no second 3740', () => {
    const base = { supplierInvoice: supplierInvoice(), setoffDate: TODAY, today: TODAY }
    const roundedUp = invoice({ total: 999.75, remaining: 999.75, carriedSek: 1000 })
    const atBetala = planSetoff({ ...base, invoice: roundedUp, amount: 1000 })
    expect(atBetala.ok && atBetala.plan.invoice).toMatchObject({ remainingAfter: 0, statusAfter: 'paid', applied: 999.75, receivableCleared: 1000, oreRounding: 0 })
    const remaining = planSetoff({ ...base, invoice: roundedUp })
    expect(remaining.ok && remaining.plan.invoice).toMatchObject({ remainingAfter: 0, applied: 999.75, receivableCleared: 1000, oreRounding: 0.25 })
    const roundedDown = planSetoff({ ...base, invoice: invoice({ total: 1000.4, remaining: 1000.4, carriedSek: 1000 }), amount: 1000 })
    expect(roundedDown.ok && roundedDown.plan.invoice).toMatchObject({ remainingAfter: 0, applied: 1000.4, receivableCleared: 1000, oreRounding: 0 })
    // A part set-off clears its own kronor; the öre wait for the settlement.
    const part = planSetoff({ ...base, invoice: roundedUp, amount: 500 })
    expect(part.ok && part.plan.invoice).toMatchObject({ remainingAfter: 499.75, applied: 500, receivableCleared: 500, oreRounding: 0 })
  })

  it('previews the lines book_counterparty_setoff posts, balanced', () => {
    const plan = planSetoff({
      invoice: invoice({ total: 999.75, remaining: 999.75, carriedSek: 1000 }),
      supplierInvoice: supplierInvoice(),
      setoffDate: TODAY,
      today: TODAY,
    })
    if (!plan.ok) throw new Error(plan.code)
    const { lines } = setoffPreview(plan.plan, { customerName: null, supplierName: null }, null)
    expect(lines).toEqual([
      { account_number: '2440', debit_amount: 999.75, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3740', debit_amount: 0.25, credit_amount: 0 },
    ])
  })

  it('refuses a date in the future or before either invoice', () => {
    const base = { invoice: invoice(), supplierInvoice: supplierInvoice(), today: TODAY }
    expect(planSetoff({ ...base, setoffDate: '2026-10-22' })).toMatchObject({ ok: false, code: 'SETOFF_DATE_INVALID', details: { reason: 'future' } })
    expect(planSetoff({ ...base, setoffDate: '2026-09-10' })).toMatchObject({
      ok: false,
      code: 'SETOFF_DATE_INVALID',
      details: { reason: 'before_invoice' },
    })
  })

  it('refuses two invoices of different counterparties', () => {
    expect(planSetoff({ invoice: invoice(), supplierInvoice: supplierInvoice({ partyId: 'other' }), setoffDate: TODAY, today: TODAY })).toEqual({
      ok: false,
      code: 'SETOFF_PARTY_MISMATCH',
    })
  })

  it.each([
    [{ documentType: 'proforma' }, 'SETOFF_INVOICE_NOT_ELIGIBLE'],
    [{ creditedInvoiceId: 'inv-0' }, 'SETOFF_INVOICE_NOT_ELIGIBLE'],
    [{ status: 'paid' }, 'SETOFF_INVOICE_NOT_OPEN'],
    [{ status: 'draft' }, 'SETOFF_INVOICE_NOT_OPEN'],
    [{ status: 'written_off' }, 'SETOFF_INVOICE_NOT_OPEN'],
    [{ remaining: 0 }, 'SETOFF_INVOICE_NOT_OPEN'],
    [{ currency: 'EUR' }, 'SETOFF_CURRENCY_UNSUPPORTED'],
    [{ deductionTotal: 500 }, 'SETOFF_DEDUCTION_UNSUPPORTED'],
    [{ booked: false }, 'SETOFF_INVOICE_NOT_BOOKED'],
    [{ partyId: null }, 'SETOFF_NO_PARTY'],
    [{ collectionOpen: true }, 'SETOFF_COLLECTION_OPEN'],
  ] as Array<[Partial<SetoffInvoiceFacts>, string]>)('refuses the customer invoice %o with %s', (over, code) => {
    expect(planSetoff({ invoice: invoice(over), supplierInvoice: supplierInvoice(), setoffDate: TODAY, today: TODAY })).toMatchObject({
      ok: false,
      code,
      details: { side: 'customer' },
    })
  })

  it.each([
    [{ isCreditNote: true }, 'SETOFF_SUPPLIER_INVOICE_NOT_ELIGIBLE'],
    [{ status: 'paid' }, 'SETOFF_SUPPLIER_INVOICE_NOT_OPEN'],
    [{ status: 'credited' }, 'SETOFF_SUPPLIER_INVOICE_NOT_OPEN'],
    [{ currency: 'EUR' }, 'SETOFF_CURRENCY_UNSUPPORTED'],
    [{ booked: false }, 'SETOFF_INVOICE_NOT_BOOKED'],
    [{ partyId: null }, 'SETOFF_NO_PARTY'],
    [{ paymentInFlight: true }, 'SETOFF_PAYMENT_IN_FLIGHT'],
  ] as Array<[Partial<SetoffSupplierInvoiceFacts>, string]>)('refuses the supplier invoice %o with %s', (over, code) => {
    expect(planSetoff({ invoice: invoice(), supplierInvoice: supplierInvoice(over), setoffDate: TODAY, today: TODAY })).toMatchObject({
      ok: false,
      code,
      details: { side: 'supplier' },
    })
  })
})

describe('eligibility', () => {
  it('accepts an open, booked SEK invoice of a party on each side', () => {
    expect(customerInvoiceIneligibility(invoice())).toBeNull()
    expect(customerInvoiceIneligibility(invoice({ status: 'overdue' }))).toBeNull()
    expect(customerInvoiceIneligibility(invoice({ status: 'partially_paid', remaining: 100 }))).toBeNull()
    expect(customerInvoiceIneligibility(invoice({ currency: null }))).toBeNull()
    expect(supplierInvoiceIneligibility(supplierInvoice())).toBeNull()
    expect(supplierInvoiceIneligibility(supplierInvoice({ status: 'approved' }))).toBeNull()
    expect(supplierInvoiceIneligibility(supplierInvoice({ status: 'overdue' }))).toBeNull()
  })
})
