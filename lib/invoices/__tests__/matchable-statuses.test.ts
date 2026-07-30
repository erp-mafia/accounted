import { describe, it, expect } from 'vitest'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
  getInvoiceMatchTargetState,
  getSupplierInvoiceMatchTargetState,
  isMatchableInvoice,
  isMatchableSupplierInvoice,
} from '../matchable-statuses'

// These lists must stay in lockstep with the CAS guards in
// app/api/transactions/[id]/match-invoice/route.ts and
// .../match-supplier-invoice/route.ts. A surface offering a target the route
// rejects produces a confirm button that can only fail.
describe('matchable status lists', () => {
  it('mirrors the customer-invoice route guard', () => {
    expect([...MATCHABLE_INVOICE_STATUSES]).toEqual(['sent', 'overdue', 'partially_paid'])
  })

  it('mirrors the supplier-invoice route guard', () => {
    expect([...MATCHABLE_SUPPLIER_INVOICE_STATUSES]).toEqual([
      'registered',
      'approved',
      'overdue',
      'partially_paid',
    ])
  })

  it('never treats a settled state as matchable', () => {
    for (const settled of ['paid', 'credited', 'cancelled', 'draft']) {
      expect([...MATCHABLE_INVOICE_STATUSES]).not.toContain(settled)
      expect([...MATCHABLE_SUPPLIER_INVOICE_STATUSES]).not.toContain(settled)
    }
  })
})

describe('invoice match target states', () => {
  it('keeps customer partial payments matchable', () => {
    expect(
      getInvoiceMatchTargetState({ status: 'partially_paid', remaining_amount: 20 }),
    ).toBe('matchable')
  })

  it('distinguishes a settled customer invoice from another non-open state', () => {
    expect(getInvoiceMatchTargetState({ status: 'paid', remaining_amount: 0 })).toBe('settled')
    expect(getInvoiceMatchTargetState({ status: 'sent', remaining_amount: 0 })).toBe('settled')
    expect(getInvoiceMatchTargetState({ status: 'cancelled', remaining_amount: 500 })).toBe(
      'not_open',
    )
    expect(getInvoiceMatchTargetState({ status: 'credited', remaining_amount: 0 })).toBe(
      'not_open',
    )
  })

  it('keeps supplier partial payments matchable', () => {
    expect(
      getSupplierInvoiceMatchTargetState({
        status: 'partially_paid',
        remaining_amount: 49,
      }),
    ).toBe('matchable')
  })

  it('distinguishes a settled supplier invoice from another non-open state', () => {
    expect(
      getSupplierInvoiceMatchTargetState({ status: 'paid', remaining_amount: 0 }),
    ).toBe('settled')
    expect(
      getSupplierInvoiceMatchTargetState({ status: 'registered', remaining_amount: 0 }),
    ).toBe('settled')

    for (const status of ['credited', 'disputed', 'reversed']) {
      expect(
        getSupplierInvoiceMatchTargetState({ status, remaining_amount: 500 }),
      ).toBe('not_open')
    }
  })

  it('fails closed when a candidate is missing or malformed', () => {
    expect(getInvoiceMatchTargetState(null)).toBe('not_open')
    expect(getInvoiceMatchTargetState({})).toBe('not_open')
    expect(
      getSupplierInvoiceMatchTargetState({ status: 'approved', remaining_amount: null }),
    ).toBe('settled')
  })
})

describe('isMatchableInvoice', () => {
  it('accepts an open invoice with an outstanding balance', () => {
    expect(isMatchableInvoice({ status: 'sent', remaining_amount: 1250 })).toBe(true)
    expect(isMatchableInvoice({ status: 'partially_paid', remaining_amount: 20 })).toBe(true)
    expect(isMatchableInvoice({ status: 'overdue', remaining_amount: 1 })).toBe(true)
  })

  // The reported bug: an invoice settled by a different transaction keeps
  // status 'paid' / remaining 0, and the dialog measured the bank amount
  // against that 0 and called it a partial payment.
  it('rejects a fully paid invoice', () => {
    expect(isMatchableInvoice({ status: 'paid', remaining_amount: 0 })).toBe(false)
  })

  it('rejects an open status whose balance is already zero', () => {
    expect(isMatchableInvoice({ status: 'sent', remaining_amount: 0 })).toBe(false)
  })

  it('rejects non-payable statuses', () => {
    expect(isMatchableInvoice({ status: 'draft', remaining_amount: 500 })).toBe(false)
    expect(isMatchableInvoice({ status: 'cancelled', remaining_amount: 500 })).toBe(false)
  })

  it('rejects a missing or malformed candidate rather than assuming matchable', () => {
    expect(isMatchableInvoice(null)).toBe(false)
    expect(isMatchableInvoice(undefined)).toBe(false)
    expect(isMatchableInvoice({})).toBe(false)
    expect(isMatchableInvoice({ status: 'sent' })).toBe(false)
    expect(isMatchableInvoice({ status: 'sent', remaining_amount: null })).toBe(false)
  })
})

describe('isMatchableSupplierInvoice', () => {
  it('accepts the open supplier states', () => {
    expect(isMatchableSupplierInvoice({ status: 'registered', remaining_amount: 549 })).toBe(true)
    expect(isMatchableSupplierInvoice({ status: 'approved', remaining_amount: 549 })).toBe(true)
    expect(isMatchableSupplierInvoice({ status: 'overdue', remaining_amount: 549 })).toBe(true)
    expect(isMatchableSupplierInvoice({ status: 'partially_paid', remaining_amount: 49 })).toBe(true)
  })

  it('rejects paid and credited targets, matching MATCH_SI_ALREADY_PAID', () => {
    expect(isMatchableSupplierInvoice({ status: 'paid', remaining_amount: 0 })).toBe(false)
    expect(isMatchableSupplierInvoice({ status: 'credited', remaining_amount: 0 })).toBe(false)
  })

  it('rejects a zero balance even on an open status', () => {
    expect(isMatchableSupplierInvoice({ status: 'registered', remaining_amount: 0 })).toBe(false)
  })

  it('rejects a missing candidate', () => {
    expect(isMatchableSupplierInvoice(null)).toBe(false)
    expect(isMatchableSupplierInvoice({})).toBe(false)
  })
})
