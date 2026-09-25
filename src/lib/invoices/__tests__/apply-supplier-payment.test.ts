import { describe, it, expect } from 'vitest'
import { planSupplierPayment, splitSupplierBankFee } from '@/lib/invoices/apply-supplier-payment'

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

describe('splitSupplierBankFee', () => {
  it('splits a EUR card payment into the invoice and a fee at the bank row rate', () => {
    // 1 749,70 EUR drawn (19 382,30 kr) for a 1 739,43 EUR invoice.
    const r = splitSupplierBankFee({
      paymentAmount: 1749.7,
      remaining: 1739.43,
      bankSek: 19382.3,
      invoiceRate: 11.055,
    })
    expect(r).toEqual({ paymentAmount: 1739.43, bankSek: 19268.53, feeSek: 113.77 })
  })

  it('converts the fee at the invoice rate when the bank SEK is unknown', () => {
    const r = splitSupplierBankFee({
      paymentAmount: 110,
      remaining: 100,
      bankSek: null,
      invoiceRate: 11,
    })
    expect(r).toEqual({ paymentAmount: 100, bankSek: null, feeSek: 110 })
  })

  it('leaves an exact or short payment untouched', () => {
    const args = { remaining: 1000, bankSek: 1000, invoiceRate: 1 }
    expect(splitSupplierBankFee({ ...args, paymentAmount: 1000 }).feeSek).toBe(0)
    expect(splitSupplierBankFee({ ...args, paymentAmount: 400, bankSek: 400 })).toEqual({
      paymentAmount: 400,
      bankSek: 400,
      feeSek: 0,
    })
  })

  it('leaves a sub-krona SEK overshoot to öresavrundning', () => {
    const r = splitSupplierBankFee({
      paymentAmount: 11232,
      remaining: 11231.25,
      bankSek: 11232,
      invoiceRate: 1,
      absorbOreRounding: true,
    })
    expect(r.feeSek).toBe(0)
    expect(r.paymentAmount).toBe(11232)
  })

  it('leaves an excess above the residual cap for planSupplierPayment to reject', () => {
    const r = splitSupplierBankFee({
      paymentAmount: 12000,
      remaining: 5000,
      bankSek: 12000,
      invoiceRate: 1,
    })
    expect(r).toEqual({ paymentAmount: 12000, bankSek: 12000, feeSek: 0 })
    expect(planSupplierPayment({ total: 5000, remaining_amount: 5000 }, r.paymentAmount).ok).toBe(false)
  })

  it('leaves the excess unconverted when no SEK figure exists at all', () => {
    const r = splitSupplierBankFee({
      paymentAmount: 110,
      remaining: 100,
      bankSek: null,
      invoiceRate: null,
    })
    expect(r.feeSek).toBe(0)
  })
})
