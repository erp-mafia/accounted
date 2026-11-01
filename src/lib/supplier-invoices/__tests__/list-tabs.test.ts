import { describe, expect, it } from 'vitest'
import { isAwaitingAttestInList, isToPayInList } from '../list-tabs'

const openOrder = { id: 'po-1', status: 'awaiting_signature', created_at: '2026-10-31T10:00:00Z', provider_status: null, provider_error_code: null }

describe('Registrerade: what can still be attested', () => {
  it('lists an unattested invoice past its due date, which is stored as overdue (the byrå list counts it as waiting)', () => {
    expect(isAwaitingAttestInList({ status: 'overdue', approved_at: null })).toBe(true)
    expect(isAwaitingAttestInList({ status: 'registered', approved_at: null })).toBe(true)
  })

  it('leaves out what is attested, paid or part paid', () => {
    expect(isAwaitingAttestInList({ status: 'approved', approved_at: '2026-10-31T10:00:00Z' })).toBe(false)
    expect(isAwaitingAttestInList({ status: 'overdue', approved_at: '2026-10-31T10:00:00Z' })).toBe(false)
    expect(isAwaitingAttestInList({ status: 'paid', approved_at: null })).toBe(false)
    expect(isAwaitingAttestInList({ status: 'partially_paid', approved_at: null })).toBe(false)
  })
})

describe('Att betala: what the payment file pays', () => {
  it('lists a part-paid attested invoice: 4 000 kr matched of 10 000 kr leaves 6 000 kr to pay', () => {
    expect(isToPayInList({ status: 'partially_paid', approved_at: '2026-10-31T10:00:00Z' })).toBe(true)
    expect(isToPayInList({ status: 'approved' })).toBe(true)
    expect(isToPayInList({ status: 'overdue' })).toBe(true)
    expect(isToPayInList({ status: 'registered' })).toBe(true)
  })

  it('leaves out what is settled, debited by the supplier, or already at the bank; a payment file keeps it', () => {
    expect(isToPayInList({ status: 'paid' })).toBe(false)
    expect(isToPayInList({ status: 'approved', auto_debit: true })).toBe(false)
    expect(isToPayInList({ status: 'approved', open_payment: { batch: null, payment_order: openOrder } })).toBe(false)
    expect(isToPayInList({ status: 'approved', open_payment: { batch: { id: 'b-1', created_at: '2026-10-31T10:00:00Z' }, payment_order: null } })).toBe(true)
  })
})
