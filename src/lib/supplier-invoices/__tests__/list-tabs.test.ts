import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('Att betala and a ticked "Inlagd i banken" (crm#1824)', () => {
  // The tabs read today's date in Stockholm: 12 Nov 2026.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T09:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // 12 500 kr due 30 Nov, ticked on 10 Nov.
  const ticked = { status: 'approved', bank_entered_at: '2026-11-10T09:00:00Z', due_date: '2026-11-30', remaining_amount: 12500 }

  it('leaves out a ticked invoice that has not fallen due', () => {
    expect(isToPayInList(ticked)).toBe(false)
    expect(isToPayInList({ ...ticked, due_date: '2026-11-12' })).toBe(false)
  })

  it('brings a ticked invoice back once it has fallen due unpaid', () => {
    expect(isToPayInList({ ...ticked, due_date: '2026-11-11' })).toBe(true)
    expect(isToPayInList({ ...ticked, status: 'overdue', due_date: '2026-11-01' })).toBe(true)
    expect(isToPayInList({ ...ticked, status: 'partially_paid', remaining_amount: 2500, due_date: '2026-11-01' })).toBe(true)
  })

  it('keeps an invoice with a real bank payment order out, ticked or not, due or not', () => {
    const open_payment = { batch: null, payment_order: openOrder }
    expect(isToPayInList({ ...ticked, open_payment })).toBe(false)
    expect(isToPayInList({ ...ticked, status: 'overdue', due_date: '2026-11-01', open_payment })).toBe(false)
  })

  it('brings the invoice straight back when the tick is taken back', () => {
    expect(isToPayInList({ ...ticked, bank_entered_at: null })).toBe(true)
  })

  it('reads a tick beside a payment file as the tick, until the invoice falls due', () => {
    const open_payment = { batch: { id: 'b-1', created_at: '2026-11-01T10:00:00Z' }, payment_order: null }
    expect(isToPayInList({ ...ticked, open_payment })).toBe(false)
    expect(isToPayInList({ ...ticked, due_date: '2026-11-01', open_payment })).toBe(true)
  })
})
