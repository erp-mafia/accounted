import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  filterSupplierInvoicesByReportedStatus,
  isAttestedAwaitingPayment,
  isSupplierInvoiceAttested,
  isSupplierInvoiceOverdue,
} from '../reported-status'
import { isAttestedInList } from '../list-tabs'
import { deriveStage } from '../stages'

const TODAY = '2026-11-13'
const ATTESTED_AT = '2026-10-20T09:00:00Z'

describe('attested: the attest mark, or the stored status approved', () => {
  it('holds for an attested invoice whatever the due date did to its status', () => {
    expect(isSupplierInvoiceAttested({ status: 'approved', approved_at: ATTESTED_AT })).toBe(true)
    // Attested on 20 Oct, due 31 Oct: the nightly flip stored it as overdue.
    expect(isSupplierInvoiceAttested({ status: 'overdue', approved_at: ATTESTED_AT })).toBe(true)
  })

  it('holds for approved without a mark: where a payment undo or an undone credit rests an invoice', () => {
    expect(isSupplierInvoiceAttested({ status: 'approved', approved_at: null })).toBe(true)
    expect(isSupplierInvoiceAttested({ status: 'approved' })).toBe(true)
  })

  it('does not hold for an invoice nobody attested, past due or not', () => {
    expect(isSupplierInvoiceAttested({ status: 'registered', approved_at: null })).toBe(false)
    expect(isSupplierInvoiceAttested({ status: 'overdue', approved_at: null })).toBe(false)
    expect(isSupplierInvoiceAttested({ status: 'partially_paid', approved_at: null })).toBe(false)
  })
})

describe('Attesterade: attested and nothing paid yet', () => {
  it('keeps an attested invoice once it is past due (stored as overdue)', () => {
    expect(isAttestedAwaitingPayment({ status: 'approved', approved_at: ATTESTED_AT })).toBe(true)
    expect(isAttestedAwaitingPayment({ status: 'overdue', approved_at: ATTESTED_AT })).toBe(true)
    expect(isAttestedInList({ status: 'overdue', approved_at: ATTESTED_AT })).toBe(true)
  })

  it('keeps approved without a mark (after a payment was undone)', () => {
    expect(isAttestedAwaitingPayment({ status: 'approved', approved_at: null })).toBe(true)
    expect(isAttestedInList({ status: 'approved', approved_at: null })).toBe(true)
  })

  it('leaves out what is not attested', () => {
    expect(isAttestedAwaitingPayment({ status: 'registered', approved_at: null })).toBe(false)
    expect(isAttestedAwaitingPayment({ status: 'overdue', approved_at: null })).toBe(false)
    expect(isAttestedInList({ status: 'overdue', approved_at: null })).toBe(false)
  })

  it('leaves out what has left the step: part paid, paid, credited, reversed, disputed', () => {
    for (const status of ['partially_paid', 'paid', 'credited', 'reversed', 'disputed']) {
      expect(isAttestedAwaitingPayment({ status, approved_at: ATTESTED_AT })).toBe(false)
    }
  })

  it('the ladder reads the same attest fact', () => {
    const base = { is_credit_note: false, in_open_batch: false, reconciled: false }
    expect(deriveStage({ ...base, status: 'overdue', approved_at: ATTESTED_AT })).toBe('approved')
    expect(deriveStage({ ...base, status: 'approved', approved_at: null })).toBe('approved')
    expect(deriveStage({ ...base, status: 'overdue', approved_at: null })).toBe('registered')
  })
})

describe('overdue: money left after the due date', () => {
  // 10 000 kr due 12 Nov; today is 13 Nov.
  const pastDue = { due_date: '2026-11-12', remaining_amount: 10000, is_credit_note: false }

  it('holds for an attested invoice past due, which is attested too', () => {
    const invoice = { ...pastDue, status: 'overdue', approved_at: ATTESTED_AT }
    expect(isSupplierInvoiceOverdue(invoice, TODAY)).toBe(true)
    expect(isAttestedAwaitingPayment(invoice)).toBe(true)
  })

  it('holds for a part-paid invoice past due: 4 000 kr paid of 10 000 kr leaves 6 000 kr overdue', () => {
    expect(isSupplierInvoiceOverdue({ ...pastDue, status: 'partially_paid', remaining_amount: 6000 }, TODAY)).toBe(true)
  })

  it('holds before the nightly flip has stored it', () => {
    expect(isSupplierInvoiceOverdue({ ...pastDue, status: 'registered' }, TODAY)).toBe(true)
    expect(isSupplierInvoiceOverdue({ ...pastDue, status: 'approved' }, TODAY)).toBe(true)
  })

  it('the due date itself is on time', () => {
    expect(isSupplierInvoiceOverdue({ ...pastDue, status: 'approved', due_date: TODAY }, TODAY)).toBe(false)
  })

  it('does not hold with nothing left, for a credit note, or for a settled, credited or disputed invoice', () => {
    expect(isSupplierInvoiceOverdue({ ...pastDue, status: 'overdue', remaining_amount: 0 }, TODAY)).toBe(false)
    expect(isSupplierInvoiceOverdue({ ...pastDue, status: 'overdue', remaining_amount: 0.004 }, TODAY)).toBe(false)
    expect(isSupplierInvoiceOverdue({ ...pastDue, status: 'overdue', is_credit_note: true }, TODAY)).toBe(false)
    for (const status of ['paid', 'credited', 'reversed', 'disputed']) {
      expect(isSupplierInvoiceOverdue({ ...pastDue, status }, TODAY)).toBe(false)
    }
  })
})

describe('the status filter of a supplier_invoices query', () => {
  const run = (status: string) => {
    const { supabase, findCall, findCalls } = createTableMockSupabase()
    filterSupplierInvoicesByReportedStatus((supabase.from('supplier_invoices') as { select: (c: string) => never }).select('*'), status, TODAY)
    return { findCall, findCalls }
  }

  it('approved: unsettled, with the mark or the stored status', () => {
    const { findCall, findCalls } = run('approved')
    expect(findCall('supplier_invoices', 'in')).toEqual(['status', ['registered', 'approved', 'overdue']])
    expect(findCall('supplier_invoices', 'or')).toEqual(['status.eq.approved,approved_at.not.is.null'])
    expect(findCalls('supplier_invoices', 'eq')).toHaveLength(0)
  })

  it('overdue: payable statuses, not a credit note, money left, due before today', () => {
    const { findCall, findCalls } = run('overdue')
    expect(findCall('supplier_invoices', 'in')).toEqual(['status', ['registered', 'approved', 'partially_paid', 'overdue']])
    expect(findCalls('supplier_invoices', 'eq')).toEqual([['is_credit_note', false]])
    expect(findCall('supplier_invoices', 'gt')).toEqual(['remaining_amount', 0.005])
    expect(findCall('supplier_invoices', 'lt')).toEqual(['due_date', TODAY])
  })

  it('every other status is the stored one', () => {
    for (const status of ['registered', 'paid', 'partially_paid', 'disputed', 'credited', 'reversed']) {
      const { findCalls } = run(status)
      expect(findCalls('supplier_invoices', 'eq')).toEqual([['status', status]])
      expect(findCalls('supplier_invoices', 'in')).toHaveLength(0)
      expect(findCalls('supplier_invoices', 'or')).toHaveLength(0)
    }
  })

  it('refuses a date that is not a date', () => {
    const { supabase } = createTableMockSupabase()
    expect(() =>
      filterSupplierInvoicesByReportedStatus((supabase.from('supplier_invoices') as { select: (c: string) => never }).select('*'), 'overdue', '2026-11-13,id.gt.0'),
    ).toThrow(/invalid date/)
  })
})
