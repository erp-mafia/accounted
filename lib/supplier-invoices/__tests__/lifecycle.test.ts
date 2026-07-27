import { describe, expect, it } from 'vitest'
import {
  canApproveSupplierInvoice,
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
