import { describe, it, expect } from 'vitest'
import { countByStage, deriveStage, openPaymentMarker, stageIndex, stagesFor, SUPPLIER_INVOICE_STAGES } from '../stages'

const base = { status: 'registered', approved_at: null, is_credit_note: false, in_open_batch: false, reconciled: false }

describe('supplier invoice stages', () => {
  it('walks the ladder from registered to reconciled', () => {
    expect(deriveStage(base)).toBe('registered')
    expect(deriveStage({ ...base, status: 'overdue' })).toBe('registered')
    expect(deriveStage({ ...base, approved_at: '2026-09-06T10:00:00Z' })).toBe('approved')
    expect(deriveStage({ ...base, status: 'approved' })).toBe('approved')
    expect(deriveStage({ ...base, approved_at: '2026-09-06T10:00:00Z', in_open_batch: true })).toBe('in_file')
    expect(deriveStage({ ...base, status: 'paid', approved_at: '2026-09-06T10:00:00Z' })).toBe('paid')
    expect(deriveStage({ ...base, status: 'paid', reconciled: true })).toBe('reconciled')
  })

  it('takes credit notes and credited invoices off the ladder', () => {
    expect(deriveStage({ ...base, is_credit_note: true })).toBe('credited')
    expect(deriveStage({ ...base, status: 'credited' })).toBe('credited')
    expect(deriveStage({ ...base, status: 'reversed', approved_at: 'x' })).toBe('credited')
    expect(stageIndex('credited')).toBe(-1)
  })

  it('a paid invoice still in an old batch reads as paid, not in file', () => {
    expect(deriveStage({ ...base, status: 'paid', in_open_batch: true })).toBe('paid')
  })

  it('kontantmetod companies skip the attest step', () => {
    expect(stagesFor('cash')).toEqual(['incoming', 'registered', 'in_file', 'paid', 'reconciled'])
    expect(stagesFor('accrual')).toEqual([...SUPPLIER_INVOICE_STAGES])
    expect(stagesFor(null)).toEqual([...SUPPLIER_INVOICE_STAGES])
  })

  it('counts invoices per stage', () => {
    const counts = countByStage([
      { stage: 'registered', approved_at: null, batch: null, payment_order: null, paid: null, reconciled_through: null },
      { stage: 'registered', approved_at: null, batch: null, payment_order: null, paid: null, reconciled_through: null },
      { stage: 'paid', approved_at: null, batch: null, payment_order: null, paid: null, reconciled_through: null },
    ])
    expect(counts.registered).toBe(2)
    expect(counts.paid).toBe(1)
    expect(counts.reconciled).toBe(0)
  })
})

describe('openPaymentMarker (crm#1243)', () => {
  const order = { id: 'order-1', status: 'accepted', created_at: '2026-10-15T13:54:35Z' }
  const batch = { id: 'batch-1', created_at: '2026-10-01T08:00:00Z' }

  it('marks an unsettled invoice a bank payment covers, before a file', () => {
    expect(openPaymentMarker({ status: 'registered', open_payment: { batch: null, payment_order: order } })).toBe('bank_payment')
    expect(openPaymentMarker({ status: 'overdue', open_payment: { batch, payment_order: order } })).toBe('bank_payment')
    expect(openPaymentMarker({ status: 'approved', open_payment: { batch, payment_order: null } })).toBe('payment_file')
    expect(openPaymentMarker({ status: 'partially_paid', open_payment: { batch, payment_order: null } })).toBe('payment_file')
  })

  it('says nothing when nothing covers the invoice', () => {
    expect(openPaymentMarker({ status: 'registered' })).toBeNull()
    expect(openPaymentMarker({ status: 'registered', open_payment: null })).toBeNull()
    expect(openPaymentMarker({ status: 'approved', open_payment: { batch: null, payment_order: null } })).toBeNull()
  })

  it('says nothing on a settled invoice or a credit note, whatever still points at it', () => {
    for (const status of ['paid', 'credited', 'reversed']) {
      expect(openPaymentMarker({ status, open_payment: { batch, payment_order: order } })).toBeNull()
    }
    expect(openPaymentMarker({ status: 'registered', is_credit_note: true, open_payment: { batch, payment_order: order } })).toBeNull()
  })
})
