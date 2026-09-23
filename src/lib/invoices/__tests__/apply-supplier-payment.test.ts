import { describe, it, expect } from 'vitest'
import { planSupplierPayment } from '@/lib/invoices/apply-supplier-payment'

describe('planSupplierPayment', () => {
  const invoice = { total: 11231.25, paid_amount: 0, remaining_amount: 11231.25 }

  it('settles in full and flags öre when a whole-krona payment is a sub-krona short (absorbOreRounding)', () => {
    const r = planSupplierPayment(invoice, 11231, { absorbOreRounding: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('paid')
      expect(r.plan.newRemaining).toBe(0)
      expect(r.plan.newPaidAmount).toBe(11231.25) // the AP, not the cash, is fully cleared
      expect(r.plan.oreSettled).toBe(true)
    }
  })

  it('accepts a sub-krona OVERpayment as öresavrundning instead of rejecting it', () => {
    const inv = { total: 11231, paid_amount: 0, remaining_amount: 11231 }
    const r = planSupplierPayment(inv, 11231.25, { absorbOreRounding: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('paid')
      expect(r.plan.oreSettled).toBe(true)
    }
  })

  it('leaves a ≥1 kr shortfall as a genuine partial', () => {
    const r = planSupplierPayment(invoice, 5000, { absorbOreRounding: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('partially_paid')
      expect(r.plan.newRemaining).toBe(6231.25)
      expect(r.plan.oreSettled).toBe(false)
    }
  })

  it('rejects an overpayment beyond the 1 kr öre band', () => {
    const r = planSupplierPayment(invoice, 12000, { absorbOreRounding: true })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('MATCH_SI_AMOUNT_EXCEEDS_REMAINING')
      expect(r.details.remaining_amount).toBe(11231.25)
    }
  })

  it('exact payment settles fully without flagging öre', () => {
    const inv = { total: 1000, paid_amount: 0, remaining_amount: 1000 }
    const r = planSupplierPayment(inv, 1000, { absorbOreRounding: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.newStatus).toBe('paid')
      expect(r.plan.oreSettled).toBe(false)
    }
  })

  describe('without öre absorption (default, preserves legacy behaviour)', () => {
    it('strands the sub-krona remainder as a partial', () => {
      const r = planSupplierPayment(invoice, 11231)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.plan.newStatus).toBe('partially_paid')
        expect(r.plan.newRemaining).toBe(0.25)
        expect(r.plan.oreSettled).toBe(false)
      }
    })

    it('rejects even a sub-krona overpayment (strict half-öre tolerance)', () => {
      const inv = { total: 11231, paid_amount: 0, remaining_amount: 11231 }
      const r = planSupplierPayment(inv, 11231.25)
      expect(r.ok).toBe(false)
    })
  })
})
