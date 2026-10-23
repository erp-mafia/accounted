import { describe, it, expect } from 'vitest'
import {
  booksInvoicesOnIssue,
  issueBooksDocument,
  invoiceBookingMoment,
  supplierInvoiceBookingMoment,
  supplierInvoiceBooksOnRegistration,
  supplierInvoiceRegistrationDate,
  cashPartialBlockReason,
  cashProRataUnsupportedReason,
  creditNoteNeedsJournalEntry,
  creditBooksOriginalFirst,
  supplierCreditNoteNeedsJournalEntry,
} from '../booking-mode'

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

describe('issueBooksDocument (crm#1202)', () => {
  const accrual = { accounting_method: 'accrual', defer_invoice_booking: false }

  it('books a faktura at issue exactly when the company books invoices on issue', () => {
    expect(issueBooksDocument({ document_type: 'invoice' }, accrual)).toBe(true)
    expect(issueBooksDocument({ document_type: null }, accrual)).toBe(true)
    expect(issueBooksDocument({}, null)).toBe(true)
    expect(issueBooksDocument({ document_type: 'invoice' }, { accounting_method: 'cash' })).toBe(false)
    expect(issueBooksDocument({ document_type: 'invoice' }, { accounting_method: 'accrual', defer_invoice_booking: true })).toBe(false)
  })

  it.each(['quote', 'proforma', 'delivery_note'])('never books a %s, even under faktureringsmetoden', (documentType) => {
    expect(issueBooksDocument({ document_type: documentType }, accrual)).toBe(false)
    expect(issueBooksDocument({ document_type: documentType }, null)).toBe(false)
  })
})

describe('invoiceBookingMoment', () => {
  it('books at issue under faktureringsmetoden and while settings are missing', () => {
    expect(invoiceBookingMoment({ accounting_method: 'accrual' })).toBe('issue')
    expect(invoiceBookingMoment(null)).toBe('issue')
    expect(invoiceBookingMoment({})).toBe('issue')
  })

  it('books at payment under kontantmetoden, whatever the defer flag says', () => {
    expect(invoiceBookingMoment({ accounting_method: 'cash' })).toBe('payment')
    expect(invoiceBookingMoment({ accounting_method: 'cash', defer_invoice_booking: true })).toBe('payment')
  })

  it('books at the explicit Bokför step when booking is deferred', () => {
    expect(invoiceBookingMoment({ accounting_method: 'accrual', defer_invoice_booking: true })).toBe('manual')
  })
})

// ML 2023:200 7 kap. 26 and 40 §§: the moms of an EU goods acquisition belongs
// to the period the invoice is issued in, whatever the buyer's method; 7 kap.
// 16 § lets reverse charge wait for the payment only for services from abroad
// and domestic reverse charge (16 kap. 6, 8-16 §§), not 16 kap. 17 §.
describe('supplierInvoiceBookingMoment (#73)', () => {
  const euGoods = { reverse_charge: true, reverse_charge_kind: 'eu_goods' }
  const euServices = { reverse_charge: true, reverse_charge_kind: 'eu_services' }

  it('books an EU goods acquisition at registration under kontantmetoden', () => {
    expect(supplierInvoiceBookingMoment('payment', euGoods, 'eu_business')).toBe('issue')
    expect(supplierInvoiceBooksOnRegistration({ accounting_method: 'cash' }, euGoods, 'eu_business')).toBe(true)
    // The defer flag never wins under kontantmetoden (invoiceBookingMoment), here neither.
    expect(
      supplierInvoiceBooksOnRegistration({ accounting_method: 'cash', defer_invoice_booking: true }, euGoods, 'eu_business'),
    ).toBe(true)
  })

  it('keeps every other kontantmetoden supplier invoice at payment', () => {
    const cash = { accounting_method: 'cash' }
    // EU services (16 kap. 9 §) and services from outside the EU follow 7 kap. 16 §.
    expect(supplierInvoiceBooksOnRegistration(cash, euServices, 'eu_business')).toBe(false)
    expect(supplierInvoiceBooksOnRegistration(cash, { reverse_charge: true, reverse_charge_kind: null }, 'eu_business')).toBe(false)
    expect(supplierInvoiceBooksOnRegistration(cash, { reverse_charge: true }, 'non_eu_business')).toBe(false)
    // Domestic reverse charge (byggtjänster, 16 kap. 13 §) and plain domestic purchases.
    expect(supplierInvoiceBooksOnRegistration(cash, { reverse_charge: true }, 'swedish_business')).toBe(false)
    expect(supplierInvoiceBooksOnRegistration(cash, { reverse_charge: false }, 'swedish_business')).toBe(false)
    // The goods word means nothing without reverse charge or from a supplier outside the EU.
    expect(supplierInvoiceBooksOnRegistration(cash, { ...euGoods, reverse_charge: false }, 'eu_business')).toBe(false)
    expect(supplierInvoiceBooksOnRegistration(cash, euGoods, 'swedish_business')).toBe(false)
    expect(supplierInvoiceBooksOnRegistration(cash, euGoods, 'non_eu_business')).toBe(false)
  })

  it('leaves faktureringsmetoden and deferred booking as they were', () => {
    expect(supplierInvoiceBookingMoment('issue', euServices, 'eu_business')).toBe('issue')
    expect(supplierInvoiceBookingMoment('manual', euGoods, 'eu_business')).toBe('manual')
    expect(supplierInvoiceBooksOnRegistration({ accounting_method: 'accrual' }, euGoods, 'eu_business')).toBe(true)
    expect(supplierInvoiceBooksOnRegistration({ accounting_method: 'accrual' }, { reverse_charge: false }, 'swedish_business')).toBe(true)
    expect(
      supplierInvoiceBooksOnRegistration({ accounting_method: 'accrual', defer_invoice_booking: true }, euGoods, 'eu_business'),
    ).toBe(false)
    expect(supplierInvoiceBooksOnRegistration(null, euGoods, 'eu_business')).toBe(true)
  })
})

// ML 2023:200 7 kap. 26 §: the output moms of an EU goods acquisition is
// reported for the invoice's period, but at the latest for the period holding
// the 15th of the month after the month of the acquisition (7 kap. 12 §);
// 7 kap. 40 § deducts the input moms in the same period.
describe('supplierInvoiceRegistrationDate (#93)', () => {
  const euGoods = { reverse_charge: true, reverse_charge_kind: 'eu_goods' }

  it('dates a late EU goods invoice on the 15th of the month after delivery', () => {
    expect(
      supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2026-03-05', delivery_date: '2026-01-10' }, 'eu_business'),
    ).toBe('2026-02-15')
    // December delivery: the cap is in January of the next year.
    expect(
      supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2027-01-20', delivery_date: '2026-12-31' }, 'eu_business'),
    ).toBe('2027-01-15')
  })

  it('keeps the invoice date when the invoice came on time or before the delivery', () => {
    // Issued on the 15th itself, before it, and before the goods arrived.
    expect(
      supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2026-02-15', delivery_date: '2026-01-10' }, 'eu_business'),
    ).toBe('2026-02-15')
    expect(
      supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2026-01-31', delivery_date: '2026-01-10' }, 'eu_business'),
    ).toBe('2026-01-31')
    expect(
      supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2026-01-05', delivery_date: '2026-02-20' }, 'eu_business'),
    ).toBe('2026-01-05')
  })

  it('keeps the invoice date without a delivery date, or for anything but an EU goods acquisition', () => {
    expect(supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2026-03-05' }, 'eu_business')).toBe('2026-03-05')
    expect(
      supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2026-03-05', delivery_date: null }, 'eu_business'),
    ).toBe('2026-03-05')
    const late = { invoice_date: '2026-03-05', delivery_date: '2026-01-10' }
    // EU services, services from outside the EU, domestic purchases.
    expect(
      supplierInvoiceRegistrationDate({ ...late, reverse_charge: true, reverse_charge_kind: 'eu_services' }, 'eu_business'),
    ).toBe('2026-03-05')
    expect(supplierInvoiceRegistrationDate({ ...late, reverse_charge: true }, 'eu_business')).toBe('2026-03-05')
    expect(supplierInvoiceRegistrationDate({ ...late, ...euGoods }, 'non_eu_business')).toBe('2026-03-05')
    expect(supplierInvoiceRegistrationDate({ ...late, reverse_charge: false }, 'swedish_business')).toBe('2026-03-05')
    expect(supplierInvoiceRegistrationDate({ ...late, ...euGoods, reverse_charge: false }, 'eu_business')).toBe('2026-03-05')
  })

  it('ignores a delivery date it cannot read', () => {
    expect(
      supplierInvoiceRegistrationDate({ ...euGoods, invoice_date: '2026-03-05', delivery_date: 'januari' }, 'eu_business'),
    ).toBe('2026-03-05')
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

describe('cashProRataUnsupportedReason', () => {
  it('accepts a SEK invoice without a tax deduction', () => {
    expect(cashProRataUnsupportedReason({ currency: 'SEK', deduction_total: 0, items: [{ deduction_type: null }] })).toBeNull()
    expect(cashProRataUnsupportedReason({ currency: 'SEK' })).toBeNull()
  })

  it('treats a missing currency as SEK', () => {
    expect(cashProRataUnsupportedReason({ currency: null })).toBeNull()
  })

  it('refuses a foreign-currency invoice', () => {
    expect(cashProRataUnsupportedReason({ currency: 'EUR' })).toBe('foreign_currency')
  })

  it('refuses a deduction on the header or on any item', () => {
    expect(cashProRataUnsupportedReason({ currency: 'SEK', deduction_total: 7500 })).toBe('tax_deduction')
    expect(
      cashProRataUnsupportedReason({ currency: 'SEK', items: [{ deduction_type: null }, { deduction_type: 'rut' }] }),
    ).toBe('tax_deduction')
  })

  it('ignores float noise below half an öre on the header deduction', () => {
    expect(cashProRataUnsupportedReason({ currency: 'SEK', deduction_total: 0.001 })).toBeNull()
  })
})

describe('creditNoteNeedsJournalEntry (customer side, #2552)', () => {
  const unpaid = {
    journal_entry_id: null,
    status: 'sent',
    paid_at: null,
    paid_amount: 0,
  }

  it('always reverses under faktureringsmetoden, even for an unpaid original', () => {
    expect(creditNoteNeedsJournalEntry('accrual', unpaid)).toBe(true)
    // Empty/absent accounting_method falls back to accrual, like the rest of
    // the module.
    expect(creditNoteNeedsJournalEntry('', unpaid)).toBe(true)
  })

  it('skips under kontantmetoden while the original is still unpaid', () => {
    // Nothing reached the ledger: no entry to reverse, recognition waits for
    // cash.
    expect(creditNoteNeedsJournalEntry('cash', unpaid)).toBe(false)
  })

  it('reverses under kontantmetoden once the payment booked the sale', () => {
    // The payment verifikat already booked revenue + utgående moms; skipping
    // the reversal would overstate both.
    expect(
      creditNoteNeedsJournalEntry('cash', {
        ...unpaid,
        status: 'paid',
        paid_at: '2026-03-12',
        paid_amount: 12500,
        journal_entry_id: 'je-1',
      }),
    ).toBe(true)
  })

  it('reverses on any single booked-ness signal in isolation', () => {
    // Different payment paths set different subsets of these fields, so each
    // signal must stand alone.
    expect(creditNoteNeedsJournalEntry('cash', { ...unpaid, journal_entry_id: 'je-1' })).toBe(true)
    expect(creditNoteNeedsJournalEntry('cash', { ...unpaid, status: 'paid' })).toBe(true)
    expect(creditNoteNeedsJournalEntry('cash', { ...unpaid, paid_at: '2026-03-12' })).toBe(true)
    expect(creditNoteNeedsJournalEntry('cash', { ...unpaid, paid_amount: 12500 })).toBe(true)
  })

  it('catches a part-paid original whose payment already booked the sale', () => {
    expect(
      creditNoteNeedsJournalEntry('cash', {
        ...unpaid,
        status: 'partially_paid',
        paid_amount: 5000,
        journal_entry_id: 'je-2',
      }),
    ).toBe(true)
  })

  it('ignores sub-öre noise and missing rows', () => {
    expect(creditNoteNeedsJournalEntry('cash', { ...unpaid, paid_amount: 0.004 })).toBe(false)
    expect(creditNoteNeedsJournalEntry('cash', { ...unpaid, paid_amount: null })).toBe(false)
    expect(creditNoteNeedsJournalEntry('cash', null)).toBe(false)
    expect(creditNoteNeedsJournalEntry('cash', undefined)).toBe(false)
  })
})

describe('creditBooksOriginalFirst (accounted#45)', () => {
  const deferred = { accounting_method: 'accrual', defer_invoice_booking: true }
  const unbooked = { status: 'sent', journal_entry_id: null, paid_at: null, paid_amount: 0 }

  it('books a sent or overdue deferred original that has no verifikat first', () => {
    expect(creditBooksOriginalFirst(deferred, unbooked)).toBe(true)
    expect(creditBooksOriginalFirst(deferred, { ...unbooked, status: 'overdue' })).toBe(true)
  })

  it('leaves an original that reached the ledger alone: linked, or booked by its payment', () => {
    expect(creditBooksOriginalFirst(deferred, { ...unbooked, journal_entry_id: 'je-1' })).toBe(false)
    expect(creditBooksOriginalFirst(deferred, { ...unbooked, status: 'paid' })).toBe(false)
    expect(creditBooksOriginalFirst(deferred, { ...unbooked, paid_at: '2026-10-01T10:00:00Z' })).toBe(false)
    expect(creditBooksOriginalFirst(deferred, { ...unbooked, paid_amount: 100 })).toBe(false)
  })

  it('never books first where the company books at issue: an unlinked original there was migrated or imported booked', () => {
    expect(creditBooksOriginalFirst({ accounting_method: 'accrual', defer_invoice_booking: false }, unbooked)).toBe(false)
    expect(creditBooksOriginalFirst({ accounting_method: 'accrual' }, unbooked)).toBe(false)
    expect(creditBooksOriginalFirst(null, unbooked)).toBe(false)
  })

  it('never books first under kontantmetoden, defer flag or not', () => {
    expect(creditBooksOriginalFirst({ accounting_method: 'cash', defer_invoice_booking: true }, unbooked)).toBe(false)
    expect(creditBooksOriginalFirst({ accounting_method: 'cash' }, unbooked)).toBe(false)
  })

  it('needs an original to read', () => {
    expect(creditBooksOriginalFirst(deferred, null)).toBe(false)
    expect(creditBooksOriginalFirst(deferred, undefined)).toBe(false)
  })

  it('still has the credit post its own verifikat after the original is booked', () => {
    expect(creditNoteNeedsJournalEntry('accrual', unbooked)).toBe(true)
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
