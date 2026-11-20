import { describe, it, expect } from 'vitest'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
  OWED_INVOICE_STATUSES,
  getInvoiceMatchTargetState,
  getSupplierInvoiceMatchTargetState,
} from '../matchable-statuses'

// These lists must stay in lockstep with the CAS guards in
// app/api/transactions/[id]/match-invoice/route.ts and
// .../match-supplier-invoice/route.ts. A surface offering a target the route
// rejects produces a confirm button that can only fail.
describe('matchable status lists', () => {
  it('mirrors the customer-invoice route guard', () => {
    expect([...MATCHABLE_INVOICE_STATUSES]).toEqual(['sent', 'overdue', 'partially_paid'])
  })

  it('is what is owed: one list, not two that agree', () => {
    expect(MATCHABLE_INVOICE_STATUSES).toBe(OWED_INVOICE_STATUSES)
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

describe('getInvoiceMatchTargetState: matchable', () => {
  it('accepts an open invoice with an outstanding balance', () => {
    expect(getInvoiceMatchTargetState({ status: 'sent', remaining_amount: 1250 })).toBe('matchable')
    expect(getInvoiceMatchTargetState({ status: 'partially_paid', remaining_amount: 20 })).toBe('matchable')
    expect(getInvoiceMatchTargetState({ status: 'overdue', remaining_amount: 1 })).toBe('matchable')
  })

  // The reported bug: an invoice settled by a different transaction keeps
  // status 'paid' / remaining 0, and the dialog measured the bank amount
  // against that 0 and called it a partial payment.
  it('rejects a fully paid invoice', () => {
    expect(getInvoiceMatchTargetState({ status: 'paid', remaining_amount: 0 })).not.toBe('matchable')
  })

  it('rejects an open status whose balance is already zero', () => {
    expect(getInvoiceMatchTargetState({ status: 'sent', remaining_amount: 0 })).not.toBe('matchable')
  })

  it('rejects non-payable statuses', () => {
    expect(getInvoiceMatchTargetState({ status: 'draft', remaining_amount: 500 })).not.toBe('matchable')
    expect(getInvoiceMatchTargetState({ status: 'cancelled', remaining_amount: 500 })).not.toBe('matchable')
  })

  it('rejects a missing or malformed candidate rather than assuming matchable', () => {
    expect(getInvoiceMatchTargetState(null)).not.toBe('matchable')
    expect(getInvoiceMatchTargetState(undefined)).not.toBe('matchable')
    expect(getInvoiceMatchTargetState({})).not.toBe('matchable')
    expect(getInvoiceMatchTargetState({ status: 'sent' })).not.toBe('matchable')
    expect(getInvoiceMatchTargetState({ status: 'sent', remaining_amount: null })).not.toBe('matchable')
  })
})

describe('getSupplierInvoiceMatchTargetState: matchable', () => {
  it('accepts the open supplier states', () => {
    expect(getSupplierInvoiceMatchTargetState({ status: 'registered', remaining_amount: 549 })).toBe('matchable')
    expect(getSupplierInvoiceMatchTargetState({ status: 'approved', remaining_amount: 549 })).toBe('matchable')
    expect(getSupplierInvoiceMatchTargetState({ status: 'overdue', remaining_amount: 549 })).toBe('matchable')
    expect(getSupplierInvoiceMatchTargetState({ status: 'partially_paid', remaining_amount: 49 })).toBe('matchable')
  })

  it('rejects paid and credited targets, matching MATCH_SI_ALREADY_PAID', () => {
    expect(getSupplierInvoiceMatchTargetState({ status: 'paid', remaining_amount: 0 })).not.toBe('matchable')
    expect(getSupplierInvoiceMatchTargetState({ status: 'credited', remaining_amount: 0 })).not.toBe('matchable')
  })

  it('rejects a zero balance even on an open status', () => {
    expect(getSupplierInvoiceMatchTargetState({ status: 'registered', remaining_amount: 0 })).not.toBe('matchable')
  })

  it('rejects a missing candidate', () => {
    expect(getSupplierInvoiceMatchTargetState(null)).not.toBe('matchable')
    expect(getSupplierInvoiceMatchTargetState({})).not.toBe('matchable')
  })
})
