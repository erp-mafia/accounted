import { describe, it, expect } from 'vitest'
import { booksInvoicesOnIssue, cashPartialBlockReason, supplierCreditNoteNeedsJournalEntry } from '../booking-mode'

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

describe('supplierCreditNoteNeedsJournalEntry', () => {
  const unpaid = {
    registration_journal_entry_id: null,
    payment_journal_entry_id: null,
    status: 'registered',
    paid_at: null,
    paid_amount: 0,
  }

  it('always reverses under faktureringsmetoden, even for an unpaid original', () => {
    expect(supplierCreditNoteNeedsJournalEntry('accrual', unpaid)).toBe(true)
    // Empty/absent accounting_method falls back to accrual, matching the rest
    // of the module.
    expect(supplierCreditNoteNeedsJournalEntry('', unpaid)).toBe(true)
  })

  it('skips under kontantmetoden while the original is still unpaid', () => {
    // Nothing reached the ledger: there is no entry to reverse and
    // recognition correctly waits for the refund.
    expect(supplierCreditNoteNeedsJournalEntry('cash', unpaid)).toBe(false)
  })

  it('reverses under kontantmetoden once the payment booked the expense', () => {
    // The payment verifikat already booked expense + 2641 ingående moms;
    // skipping the reversal would overstate both.
    expect(
      supplierCreditNoteNeedsJournalEntry('cash', {
        ...unpaid,
        status: 'paid',
        paid_at: '2026-03-12',
        paid_amount: 781,
        payment_journal_entry_id: 'je-1',
      }),
    ).toBe(true)
  })

  it('reverses on any single booked-ness signal in isolation', () => {
    // Each signal must stand alone: rows written by different payment paths
    // set different subsets of these fields.
    expect(supplierCreditNoteNeedsJournalEntry('cash', { ...unpaid, payment_journal_entry_id: 'je-1' })).toBe(true)
    expect(supplierCreditNoteNeedsJournalEntry('cash', { ...unpaid, registration_journal_entry_id: 'je-2' })).toBe(true)
    expect(supplierCreditNoteNeedsJournalEntry('cash', { ...unpaid, status: 'paid' })).toBe(true)
    expect(supplierCreditNoteNeedsJournalEntry('cash', { ...unpaid, paid_at: '2026-03-12' })).toBe(true)
  })

  it('catches a part-paid original that predates the #1413 guard', () => {
    // status is still 'partially_paid', but a payment entry exists, so the
    // expense IS on the ledger. status alone would miss this.
    expect(
      supplierCreditNoteNeedsJournalEntry('cash', {
        ...unpaid,
        status: 'partially_paid',
        paid_amount: 781,
        payment_journal_entry_id: 'je-3',
      }),
    ).toBe(true)
  })

  it('ignores sub-öre noise and missing rows', () => {
    expect(supplierCreditNoteNeedsJournalEntry('cash', { ...unpaid, paid_amount: 0.004 })).toBe(false)
    expect(supplierCreditNoteNeedsJournalEntry('cash', { ...unpaid, paid_amount: null })).toBe(false)
    expect(supplierCreditNoteNeedsJournalEntry('cash', null)).toBe(false)
    expect(supplierCreditNoteNeedsJournalEntry('cash', undefined)).toBe(false)
  })
})
