import { describe, it, expect } from 'vitest'
import { booksInvoicesOnIssue, cashPartialBlockReason } from '../booking-mode'

describe('booksInvoicesOnIssue (#967)', () => {
  it('books at issue for accrual companies by default', () => {
    expect(booksInvoicesOnIssue({ accounting_method: 'accrual' })).toBe(true)
    expect(booksInvoicesOnIssue({ accounting_method: 'accrual', defer_invoice_booking: false })).toBe(true)
  })

  it('defers when defer_invoice_booking is on', () => {
    expect(booksInvoicesOnIssue({ accounting_method: 'accrual', defer_invoice_booking: true })).toBe(false)
  })

  it('never books at issue under the cash method, regardless of the flag', () => {
    expect(booksInvoicesOnIssue({ accounting_method: 'cash' })).toBe(false)
    expect(booksInvoicesOnIssue({ accounting_method: 'cash', defer_invoice_booking: true })).toBe(false)
  })

  it('treats missing settings as the historical accrual default', () => {
    expect(booksInvoicesOnIssue(null)).toBe(true)
    expect(booksInvoicesOnIssue(undefined)).toBe(true)
    expect(booksInvoicesOnIssue({})).toBe(true)
  })
})

describe('cashPartialBlockReason', () => {
  const base = {
    invoiceAlreadyBooked: false,
    accountingMethod: 'cash',
    priorPaidAmount: 0,
    paysRemainingInFull: true,
  }

  it('allows a full settlement from a fully unpaid state', () => {
    expect(cashPartialBlockReason(base)).toBeNull()
  })

  it('blocks a partial payment on a never-booked cash invoice', () => {
    expect(cashPartialBlockReason({ ...base, paysRemainingInFull: false })).toBe('partial_payment')
  })

  it('blocks completing a previously part-paid never-booked invoice', () => {
    expect(cashPartialBlockReason({ ...base, priorPaidAmount: 500 })).toBe(
      'previously_partially_paid',
    )
  })

  it('never blocks invoices that were booked at issue (clearing entry handles partials)', () => {
    expect(
      cashPartialBlockReason({ ...base, invoiceAlreadyBooked: true, paysRemainingInFull: false }),
    ).toBeNull()
  })

  it('never blocks under the accrual method, including the null-settings fallback', () => {
    expect(
      cashPartialBlockReason({ ...base, accountingMethod: 'accrual', paysRemainingInFull: false }),
    ).toBeNull()
    expect(
      cashPartialBlockReason({ ...base, accountingMethod: '', paysRemainingInFull: false }),
    ).toBeNull()
  })

  it('ignores sub-öre noise in the prior paid amount', () => {
    expect(cashPartialBlockReason({ ...base, priorPaidAmount: 0.004 })).toBeNull()
    expect(cashPartialBlockReason({ ...base, priorPaidAmount: null })).toBeNull()
    expect(cashPartialBlockReason({ ...base, priorPaidAmount: undefined })).toBeNull()
  })
})
