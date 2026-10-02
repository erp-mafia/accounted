import { describe, it, expect } from 'vitest'
import {
  planSupplierBankMatch,
  planSupplierPayment,
  splitSupplierBankFee,
} from '@/lib/invoices/apply-supplier-payment'

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

  // The öre band is open at one krona (supplierOreResidual absorbs only a
  // residual strictly under it): an excess of exactly 1.00 is not öre, and
  // accepting it as a partial would push paid_amount past the total.
  it('rejects an overpayment of exactly one krona (the band is open at 1.00)', () => {
    const inv = { total: 1000, paid_amount: 0, remaining_amount: 1000 }
    const r = planSupplierPayment(inv, 1001, { absorbOreRounding: true })
    expect(r).toMatchObject({ ok: false, code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING', details: { excess: 1 } })
    expect(planSupplierPayment(inv, 1000.99, { absorbOreRounding: true }).ok).toBe(true)
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

  it('books an excess of exactly one krona as a fee, not as öre', () => {
    const r = splitSupplierBankFee({
      paymentAmount: 1001,
      remaining: 1000,
      bankSek: 1001,
      invoiceRate: 1,
      absorbOreRounding: true,
    })
    expect(r).toEqual({ paymentAmount: 1000, bankSek: 1000, feeSek: 1 })
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

describe('planSupplierBankMatch', () => {
  // A SEK invoice posted to 2440 at receipt (faktureringsmetoden).
  const booked = (over: Record<string, unknown> = {}) => ({
    total: 1000,
    paid_amount: 0,
    remaining_amount: 1000,
    currency: 'SEK',
    exchange_rate: null,
    registration_journal_entry_id: 'je-registration',
    ...over,
  })
  // The same invoice never booked: kontantmetoden books it at payment.
  const unbooked = (over: Record<string, unknown> = {}) =>
    booked({ registration_journal_entry_id: null, ...over })
  const tx = (amount: number, currency = 'SEK', amount_sek: number | null = null) => ({
    amount,
    currency,
    amount_sek,
  })
  const plan = (
    invoice: ReturnType<typeof booked>,
    transaction: ReturnType<typeof tx>,
    accountingMethod = 'accrual',
  ) => planSupplierBankMatch({ invoice, transaction, accountingMethod })

  describe('faktureringsmetoden, pure SEK', () => {
    it('an exact payment clears the debt with no fee and no öre line', () => {
      const r = plan(booked(), tx(-1000))
      expect(r).toMatchObject({
        ok: true,
        plan: { newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0, settledAmount: 1000, bankFeeSek: 0 },
      })
      if (r.ok) {
        expect(r.plan.booking).toEqual({
          kind: 'clearing',
          paymentAmount: 1000,
          sekClearingDebt: 1000,
          bankFeeSek: 0,
        })
      }
    })

    it('a fee on top settles the invoice in full and books the excess on 6570, not on 2440', () => {
      const r = plan(booked(), tx(-1010))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.plan.bankFeeSek).toBe(10)
      expect(r.plan.booking).toEqual({
        kind: 'clearing',
        paymentAmount: 1000,
        sekClearingDebt: 1000,
        bankFeeSek: 10,
      })
      // The supplier ledger records the debt, never more than the invoice.
      expect(r.plan.newPaidAmount).toBe(1000)
      expect(r.plan.settledAmount).toBe(1000)
      expect(r.plan.newStatus).toBe('paid')
    })

    it('a whole-krona payment a sub-krona short settles in full (3740)', () => {
      const r = plan(booked({ total: 1234.44, remaining_amount: 1234.44 }), tx(-1234))
      expect(r).toMatchObject({
        ok: true,
        plan: { newStatus: 'paid', newPaidAmount: 1234.44, newRemaining: 0, settledAmount: 1234.44, oreSettled: true },
      })
      if (r.ok) {
        expect(r.plan.booking).toEqual({
          kind: 'clearing',
          paymentAmount: 1234,
          sekClearingDebt: 1234.44,
          bankFeeSek: 0,
        })
      }
    })

    it('a whole-krona payment a sub-krona over settles in full (3740), not as a fee', () => {
      const r = plan(booked({ total: 1234.44, remaining_amount: 1234.44 }), tx(-1235))
      expect(r).toMatchObject({ ok: true, plan: { newStatus: 'paid', oreSettled: true, bankFeeSek: 0 } })
      if (r.ok) expect(r.plan.booking).toMatchObject({ paymentAmount: 1235, sekClearingDebt: 1234.44 })
    })

    // #3253 review: the fee split, the overshoot guard and the öre residual
    // used to leave a gap at exactly 1.00 over: no fee, no 3740, no refusal,
    // 1930 credited a krona less than the bank row and paid_amount past the
    // total. An excess of exactly one krona is a fee.
    it('an excess of exactly one krona is a fee on 6570, not a gap', () => {
      const r = plan(booked(), tx(-1001))
      expect(r).toMatchObject({
        ok: true,
        plan: { newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0, settledAmount: 1000, bankFeeSek: 1 },
      })
      if (r.ok) {
        expect(r.plan.booking).toEqual({
          kind: 'clearing',
          paymentAmount: 1000,
          sekClearingDebt: 1000,
          bankFeeSek: 1,
        })
      }
    })

    it('an excess of exactly one krona on a part-paid invoice is a fee, paid_amount stays at the total', () => {
      const r = plan(booked({ paid_amount: 500, remaining_amount: 500 }), tx(-501))
      expect(r).toMatchObject({
        ok: true,
        plan: { newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0, settledAmount: 500, bankFeeSek: 1 },
      })
      if (r.ok) expect(r.plan.booking).toMatchObject({ paymentAmount: 500, sekClearingDebt: 500, bankFeeSek: 1 })
    })

    it('a payment a krona or more short is a partial', () => {
      const r = plan(booked(), tx(-500))
      expect(r).toMatchObject({
        ok: true,
        plan: { newStatus: 'partially_paid', newPaidAmount: 500, newRemaining: 500, settledAmount: 500 },
      })
      if (r.ok) expect(r.plan.booking).toMatchObject({ paymentAmount: 500, sekClearingDebt: 1000 })
    })

    it('completing a part-paid invoice settles only what remained', () => {
      const r = plan(booked({ paid_amount: 400, remaining_amount: 600 }), tx(-600))
      expect(r).toMatchObject({
        ok: true,
        plan: { newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0, settledAmount: 600 },
      })
    })

    it('refuses an overshoot past the fee cap before anything is booked', () => {
      const r = plan(booked({ total: 5000, remaining_amount: 5000 }), tx(-50000))
      expect(r).toEqual({
        ok: false,
        code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING',
        details: { transaction_amount: 50000, remaining_amount: 5000, excess: 45000 },
      })
    })
  })

  describe('faktureringsmetoden, foreign currency', () => {
    const eur = (over: Record<string, unknown> = {}) =>
      booked({ total: 100, remaining_amount: 100, currency: 'EUR', exchange_rate: 11, ...over })

    it('clears 2440 at the booked SEK and books the kursvinst against the bank SEK', () => {
      const r = plan(eur(), tx(-100, 'EUR', -1050))
      expect(r).toMatchObject({ ok: true, plan: { newStatus: 'paid', settledAmount: 100 } })
      if (r.ok) {
        expect(r.plan.booking).toEqual({
          kind: 'clearing',
          paymentAmount: 1100,
          exchangeRateDifference: 50,
          bankFeeSek: 0,
        })
      }
    })

    it('a SEK row paying a foreign invoice settles what remains, with the kursförlust', () => {
      const r = plan(eur(), tx(-1150))
      expect(r).toMatchObject({ ok: true, plan: { newStatus: 'paid', newPaidAmount: 100, settledAmount: 100 } })
      if (r.ok) expect(r.plan.booking).toMatchObject({ paymentAmount: 1100, exchangeRateDifference: -50 })
    })

    it('a foreign row without amount_sek books at the invoice rate, with no kursdifferens', () => {
      const r = plan(eur(), tx(-100, 'EUR'))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.plan.booking).toEqual({ kind: 'clearing', paymentAmount: 1100, bankFeeSek: 0 })
    })

    it('splits a EUR card fee on top at the bank row rate', () => {
      const r = plan(
        eur({ total: 1739.43, remaining_amount: 1739.43, exchange_rate: 11.055 }),
        tx(-1749.7, 'EUR', -19382.3),
      )
      expect(r).toMatchObject({ ok: true, plan: { newStatus: 'paid', newPaidAmount: 1739.43, bankFeeSek: 113.77 } })
      if (r.ok) {
        expect(r.plan.booking).toEqual({
          kind: 'clearing',
          paymentAmount: 19229.4,
          exchangeRateDifference: -39.13,
          bankFeeSek: 113.77,
        })
      }
    })

    it('refuses when neither the bank row nor the invoice yields a SEK figure', () => {
      expect(plan(eur({ exchange_rate: null }), tx(-100, 'EUR'))).toEqual({
        ok: false,
        code: 'SI_FX_RATE_MISSING',
        details: { transaction_currency: 'EUR', invoice_currency: 'EUR' },
      })
    })
  })

  describe('kontantmetoden', () => {
    it('books a never-booked SEK invoice at payment with the bank SEK', () => {
      const r = plan(unbooked(), tx(-1000), 'cash')
      expect(r).toMatchObject({ ok: true, plan: { newStatus: 'paid', settledAmount: 1000 } })
      if (r.ok) expect(r.plan.booking).toEqual({ kind: 'cash', settledBankSek: 1000, bankFeeSek: 0 })
    })

    it('passes a fee on top to the cash builder', () => {
      const r = plan(unbooked(), tx(-1010), 'cash')
      expect(r).toMatchObject({ ok: true, plan: { newPaidAmount: 1000, bankFeeSek: 10 } })
      if (r.ok) expect(r.plan.booking).toEqual({ kind: 'cash', settledBankSek: 1000, bankFeeSek: 10 })
    })

    it('books an excess of exactly one krona as a fee', () => {
      const r = plan(unbooked(), tx(-1001), 'cash')
      expect(r).toMatchObject({ ok: true, plan: { newStatus: 'paid', newPaidAmount: 1000, bankFeeSek: 1 } })
      if (r.ok) expect(r.plan.booking).toEqual({ kind: 'cash', settledBankSek: 1000, bankFeeSek: 1 })
    })

    it('absorbs öre: a whole-krona row a sub-krona short settles in full', () => {
      const r = plan(unbooked({ total: 1234.44, remaining_amount: 1234.44 }), tx(-1234), 'cash')
      expect(r).toMatchObject({ ok: true, plan: { newStatus: 'paid', oreSettled: true } })
      if (r.ok) expect(r.plan.booking).toEqual({ kind: 'cash', settledBankSek: 1234, bankFeeSek: 0 })
    })

    it('refuses a partial payment of a never-booked invoice', () => {
      expect(plan(unbooked(), tx(-500), 'cash')).toEqual({
        ok: false,
        code: 'SI_CASH_PARTIAL_UNSUPPORTED',
        details: { reason: 'partial_payment', payment_amount: 500, remaining_amount: 1000 },
      })
    })

    it('refuses completing a previously part-paid never-booked invoice', () => {
      const r = plan(unbooked({ paid_amount: 400, remaining_amount: 600 }), tx(-600), 'cash')
      expect(r).toMatchObject({ ok: false, code: 'SI_CASH_PARTIAL_UNSUPPORTED', details: { reason: 'previously_partially_paid' } })
    })

    it('refuses a partial foreign payment across rates', () => {
      const r = plan(
        unbooked({ total: 100, remaining_amount: 100, currency: 'EUR', exchange_rate: 11 }),
        tx(-50, 'EUR', -560),
        'cash',
      )
      expect(r).toEqual({
        ok: false,
        code: 'MATCH_SI_CASH_FX_UNSUPPORTED',
        details: { exchangeRateDifference: -10, invoiceCurrency: 'EUR', transactionCurrency: 'EUR' },
      })
    })

    it('pins a full foreign settlement to the SEK that left the bank', () => {
      const r = plan(
        unbooked({ total: 100, remaining_amount: 100, currency: 'EUR', exchange_rate: 11 }),
        tx(-1150),
        'cash',
      )
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.plan.booking).toEqual({ kind: 'cash', settledBankSek: 1150, bankFeeSek: 0 })
    })

    it('keeps the invoice rate on a same-rate foreign settlement', () => {
      const r = plan(
        unbooked({ total: 100, remaining_amount: 100, currency: 'EUR', exchange_rate: 11 }),
        tx(-100, 'EUR'),
        'cash',
      )
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.plan.booking).toEqual({ kind: 'cash', settledBankSek: undefined, bankFeeSek: 0 })
    })

    // The cash builder would throw SI_FX_RATE_MISSING mid-booking for this
    // row, after the v1 door had already reversed a prior categorisation: the
    // plan refuses it first, with the same code.
    it('refuses a foreign invoice with no rate before anything is booked', () => {
      const rateless = unbooked({ total: 100, remaining_amount: 100, currency: 'EUR', exchange_rate: null })
      expect(plan(rateless, tx(-1100), 'cash')).toEqual({
        ok: false,
        code: 'SI_FX_RATE_MISSING',
        details: { transaction_currency: 'SEK', invoice_currency: 'EUR' },
      })
      expect(plan(rateless, tx(-100, 'EUR', -1100), 'cash')).toEqual({
        ok: false,
        code: 'SI_FX_RATE_MISSING',
        details: { transaction_currency: 'EUR', invoice_currency: 'EUR' },
      })
    })

    it('clears 2440 for an invoice booked at receipt, whatever the company setting', () => {
      const r = plan(booked(), tx(-1000), 'cash')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.plan.booking.kind).toBe('clearing')
    })
  })
})
