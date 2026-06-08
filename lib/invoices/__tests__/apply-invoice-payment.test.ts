import { describe, it, expect } from 'vitest'
import {
  planInvoicePayment,
  PAYMENT_OVERSHOOT_TOLERANCE,
} from '@/lib/invoices/apply-invoice-payment'

describe('planInvoicePayment', () => {
  it('marks fully paid on an exact payment', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 0, remaining_amount: 1000 }, 1000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan).toEqual({
        newPaidAmount: 1000,
        newRemaining: 0,
        isFullyPaid: true,
        newStatus: 'paid',
      })
    }
  })

  it('marks partially paid on a partial payment', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 0, remaining_amount: 1000 }, 400)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('partially_paid')
      expect(r.plan.newPaidAmount).toBe(400)
      expect(r.plan.newRemaining).toBe(600)
      expect(r.plan.isFullyPaid).toBe(false)
    }
  })

  it('accumulates onto an existing paid_amount', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 600, remaining_amount: 400 }, 400)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newPaidAmount).toBe(1000)
      expect(r.plan.isFullyPaid).toBe(true)
    }
  })

  it('REJECTS overpayment (the bug: agent/v1 paths used to swallow it)', () => {
    const r = planInvoicePayment({ total: 1000, paid_amount: 0, remaining_amount: 1000 }, 1500)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
      expect(r.details).toEqual({
        transaction_amount: 1500,
        remaining_amount: 1000,
        excess: 500,
      })
    }
  })

  it('accepts a sub-öre overshoot (float drift) but rejects a real one-öre over', () => {
    expect(planInvoicePayment({ total: 1000, remaining_amount: 1000 }, 1000.004).ok).toBe(true)
    expect(planInvoicePayment({ total: 1000, remaining_amount: 1000 }, 1000.01).ok).toBe(false)
  })

  it('falls back to total - paid_amount when remaining_amount is absent', () => {
    expect(planInvoicePayment({ total: 1000, paid_amount: 300 }, 700).ok).toBe(true)
    expect(planInvoicePayment({ total: 1000, paid_amount: 300 }, 701).ok).toBe(false)
  })

  it('overshoot tolerance is half an öre', () => {
    expect(PAYMENT_OVERSHOOT_TOLERANCE).toBe(0.005)
  })
})
