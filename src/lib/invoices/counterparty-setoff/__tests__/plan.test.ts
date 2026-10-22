import { describe, expect, it } from 'vitest'
import {
  customerInvoiceIneligibility,
  planSetoff,
  setoffDefaultAmount,
  supplierInvoiceIneligibility,
  type SetoffInvoiceFacts,
  type SetoffSupplierInvoiceFacts,
} from '../plan'

const PARTY = 'party-crayfish'

/** Oppy's July case: a customer invoice of 1 388 kr and a self-billed supplier invoice of 4 504 kr. */
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
  it("sets off Oppy's July invoices: the customer invoice is paid and we pay the 3 116 kr net", () => {
    const result = planSetoff({ invoice: invoice(), supplierInvoice: supplierInvoice(), setoffDate: '2026-09-30', today: TODAY })
    expect(result).toEqual({
      ok: true,
      plan: {
        amount: 1388,
        setoffDate: '2026-09-30',
        partyId: PARTY,
        invoice: { id: 'inv-1', number: '2631', remainingBefore: 1388, remainingAfter: 0, statusAfter: 'paid' },
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
    expect(planSetoff({ ...base, amount: 1388.01 })).toMatchObject({ ok: false, code: 'SETOFF_AMOUNT_EXCEEDS_REMAINING' })
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
