import { describe, expect, it } from 'vitest'
import {
  canApproveSupplierInvoice,
  canMarkSupplierInvoiceBankEntered,
  findChangedVerifikatFields,
  findLockedVerifikatFields,
  isOverduePayable,
  isUnsettledSupplierInvoiceStatus,
  resolveUnsettledStatus,
} from '@/lib/supplier-invoices/lifecycle'

/**
 * These assertions mirror update_overdue_supplier_invoices()
 * (20260727160000_supplier_invoice_overdue_symmetric.sql). The pg-real test
 * (tests/pg/supplier-invoice-overdue-cron.pg.test.ts) pins the SQL side; this
 * file pins the app side so the two cannot drift apart silently.
 */

const TODAY = '2026-07-27'
const PAST = '2026-07-01'
const FUTURE = '2026-12-31'

describe('isOverduePayable', () => {
  it('is true for an unpaid payable past its due date', () => {
    expect(isOverduePayable({ due_date: PAST, remaining_amount: 1000 }, TODAY)).toBe(true)
  })

  it('is false on the due date itself (the cron uses due_date < CURRENT_DATE)', () => {
    expect(isOverduePayable({ due_date: TODAY, remaining_amount: 1000 }, TODAY)).toBe(false)
  })

  it('is false when nothing is left to pay, öre rounding included', () => {
    expect(isOverduePayable({ due_date: PAST, remaining_amount: 0 }, TODAY)).toBe(false)
    expect(isOverduePayable({ due_date: PAST, remaining_amount: 0.004 }, TODAY)).toBe(false)
    expect(isOverduePayable({ due_date: PAST, remaining_amount: 0.01 }, TODAY)).toBe(true)
  })

  it('is false for a credit note: a kreditfaktura is not a payable', () => {
    expect(
      isOverduePayable({ due_date: PAST, remaining_amount: 1000, is_credit_note: true }, TODAY),
    ).toBe(false)
  })
})

describe('resolveUnsettledStatus', () => {
  it('returns overdue for a past-due payable regardless of attest state', () => {
    expect(resolveUnsettledStatus({ due_date: PAST, remaining_amount: 1000 }, TODAY)).toBe('overdue')
    expect(
      resolveUnsettledStatus(
        { due_date: PAST, remaining_amount: 1000, approved_at: '2026-07-02T08:00:00Z' },
        TODAY,
      ),
    ).toBe('overdue')
  })

  it('un-flips to registered when the due date moves out of the past', () => {
    expect(resolveUnsettledStatus({ due_date: FUTURE, remaining_amount: 1000 }, TODAY)).toBe(
      'registered',
    )
  })

  it('un-flips to approved when the invoice was attested', () => {
    expect(
      resolveUnsettledStatus(
        { due_date: FUTURE, remaining_amount: 1000, approved_at: '2026-07-02T08:00:00Z' },
        TODAY,
      ),
    ).toBe('approved')
  })
})

describe('isUnsettledSupplierInvoiceStatus', () => {
  it('covers exactly the statuses the overdue flip owns', () => {
    expect(isUnsettledSupplierInvoiceStatus('registered')).toBe(true)
    expect(isUnsettledSupplierInvoiceStatus('approved')).toBe(true)
    expect(isUnsettledSupplierInvoiceStatus('overdue')).toBe(true)
    for (const settled of ['paid', 'partially_paid', 'credited', 'reversed', 'disputed']) {
      expect(isUnsettledSupplierInvoiceStatus(settled)).toBe(false)
    }
  })
})

describe('canApproveSupplierInvoice', () => {
  it('allows a registered invoice', () => {
    expect(canApproveSupplierInvoice({ status: 'registered' })).toBe(true)
  })

  it('allows an overdue invoice that has never been attested', () => {
    expect(canApproveSupplierInvoice({ status: 'overdue', approved_at: null })).toBe(true)
  })

  it('refuses once approved_at is set, so approval is idempotent', () => {
    expect(
      canApproveSupplierInvoice({ status: 'overdue', approved_at: '2026-07-02T08:00:00Z' }),
    ).toBe(false)
    expect(
      canApproveSupplierInvoice({ status: 'approved', approved_at: '2026-07-02T08:00:00Z' }),
    ).toBe(false)
  })

  it('refuses settled statuses', () => {
    expect(canApproveSupplierInvoice({ status: 'paid' })).toBe(false)
    expect(canApproveSupplierInvoice({ status: 'credited' })).toBe(false)
  })
})

/**
 * #1230: the two fields that are copied onto the registration verifikat
 * (entry_date and the description) must stop being freely writable once that
 * verifikat exists, on every update path that shares the schema.
 */
describe('findLockedVerifikatFields', () => {
  const BOOKED = {
    registration_journal_entry_id: 'je-1',
    invoice_date: '2026-06-30',
    supplier_invoice_number: 'F-1001',
  }

  it('locks nothing while the invoice is unbooked', () => {
    expect(
      findLockedVerifikatFields(
        { invoice_date: '2026-07-15', supplier_invoice_number: 'F-2002' },
        { ...BOOKED, registration_journal_entry_id: null },
      ),
    ).toEqual([])
  })

  it('locks the invoice date once the registration entry is posted', () => {
    expect(findLockedVerifikatFields({ invoice_date: '2026-07-15' }, BOOKED)).toEqual([
      'invoice_date',
    ])
  })

  it('locks the invoice number too: it is part of the verifikat description', () => {
    expect(findLockedVerifikatFields({ supplier_invoice_number: 'F-2002' }, BOOKED)).toEqual([
      'supplier_invoice_number',
    ])
  })

  it('reports every changed field so the error can name them', () => {
    expect(
      findLockedVerifikatFields(
        { invoice_date: '2026-07-15', supplier_invoice_number: 'F-2002' },
        BOOKED,
      ),
    ).toEqual(['invoice_date', 'supplier_invoice_number'])
  })

  it('accepts a resent identical value: a full-form PUT changes nothing', () => {
    expect(
      findLockedVerifikatFields(
        { invoice_date: '2026-06-30', supplier_invoice_number: 'F-1001', due_date: '2026-08-31' },
        BOOKED,
      ),
    ).toEqual([])
  })

  it('leaves due_date, payment_reference and notes alone', () => {
    expect(
      findLockedVerifikatFields(
        { due_date: '2026-09-30', payment_reference: 'OCR-1', notes: 'ny not' },
        BOOKED,
      ),
    ).toEqual([])
  })

  it('treats a first-time delivery/invoice value against a null column as a change', () => {
    expect(
      findLockedVerifikatFields(
        { supplier_invoice_number: 'F-2002' },
        { ...BOOKED, supplier_invoice_number: null },
      ),
    ).toEqual(['supplier_invoice_number'])
  })
})

describe('findChangedVerifikatFields', () => {
  const ROW = { invoice_date: '2026-06-30', supplier_invoice_number: 'F-1001' }

  it('reports the moving fields regardless of whether an entry is posted', () => {
    // This is what the routes pin their write on: an unbooked invoice can be
    // booked between the lock check and the update, so "would this change a
    // verifikat field" has to be answerable without the booked flag.
    expect(findChangedVerifikatFields({ invoice_date: '2026-07-15' }, ROW)).toEqual([
      'invoice_date',
    ])
  })

  it('is empty when the update only resends stored values', () => {
    expect(findChangedVerifikatFields({ ...ROW, notes: 'x' }, ROW)).toEqual([])
  })

  it('is empty for a metadata-only update', () => {
    expect(findChangedVerifikatFields({ due_date: '2026-09-30' }, ROW)).toEqual([])
  })
})

describe('canMarkSupplierInvoiceBankEntered', () => {
  // "Inlagd i banken" (#2220) is the step right before "Markera som betald",
  // so it is offered on exactly the rows that action is offered on.
  it.each(['approved', 'overdue', 'partially_paid'])('allows a payable %s invoice', (status) => {
    expect(canMarkSupplierInvoiceBankEntered({ status })).toBe(true)
  })

  it.each(['registered', 'paid', 'credited', 'reversed', 'disputed'])(
    'refuses a %s invoice',
    (status) => {
      expect(canMarkSupplierInvoiceBankEntered({ status })).toBe(false)
    },
  )

  it('refuses a credit note whatever its status', () => {
    expect(canMarkSupplierInvoiceBankEntered({ status: 'approved', is_credit_note: true })).toBe(false)
  })
})
