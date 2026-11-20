import { describe, expect, it, vi } from 'vitest'
import { planSupplierBankMatch } from '@/lib/invoices/apply-supplier-payment'
import { fxPaidInInvoiceCurrency, planMatchPayment } from '@/lib/invoices/match-payment-plan'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

/**
 * How far a SEK payment may sit from a foreign invoice's remainder and still
 * settle it, at both single-match doors, read at the payment-day rate. 1000 EUR
 * remaining, booked at 11.30, 11.40 on the payment day: 11 400 kr is the whole
 * remainder at the mid rate.
 */
const invoice = { total: 1000, paid_amount: 0, remaining_amount: 1000, currency: 'EUR', exchange_rate: 11.3, registration_journal_entry_id: 'je' }
const paymentRate = 11.4

function customer(sek: number) {
  const paid = fxPaidInInvoiceCurrency(sek, paymentRate, invoice)
  return planMatchPayment(invoice, paid, { pureSek: false })
}

function supplier(sek: number, overrides: Record<string, unknown> = {}, accountingMethod = 'accrual') {
  return planSupplierBankMatch({
    invoice: { ...invoice, ...overrides },
    transaction: { amount: -sek, currency: 'SEK', amount_sek: null },
    accountingMethod,
    paymentRate,
  } as never)
}

describe('half a payment', () => {
  it('leaves the rest open on the customer door', () => {
    const plan = customer(5700)
    expect(plan).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', newRemaining: 500 } })
  })

  it('leaves the rest open on the supplier door, with no gain on the half that was not paid', () => {
    const plan = supplier(5700)
    expect(plan).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', newRemaining: 500, settledAmount: 500 } })
    expect(plan.ok && plan.plan.booking).toMatchObject({ kind: 'clearing', paymentAmount: 5650, exchangeRateDifference: -50 })
  })

  it('is no settlement of a kontantmetoden invoice: never the whole invoice at half its value', () => {
    const plan = supplier(5700, { registration_journal_entry_id: null }, 'cash')
    expect(plan).toMatchObject({ ok: false, code: 'MATCH_SI_CASH_FX_UNSUPPORTED' })
  })

  it('a kontantmetoden invoice with no rate of its own is refused too', () => {
    const plan = supplier(5700, { registration_journal_entry_id: null, exchange_rate: null }, 'cash')
    expect(plan).toMatchObject({ ok: false, code: 'SI_CASH_PARTIAL_UNSUPPORTED' })
  })
})

describe('a payment 5 % short', () => {
  it('is a part payment on both doors', () => {
    expect(customer(10830)).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', newRemaining: 50 } })
    expect(supplier(10830)).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', newRemaining: 50 } })
  })
})

describe('a payment inside the band', () => {
  it('settles the remainder on both doors, the difference a kursdifferens', () => {
    expect(customer(11300)).toMatchObject({ ok: true, plan: { newStatus: 'paid', newRemaining: 0 } })
    expect(supplier(11300)).toMatchObject({ ok: true, plan: { newStatus: 'paid', newRemaining: 0 } })
  })
})

describe('with no rate of the payment day', () => {
  it('reads the band at the invoice rate', () => {
    const plan = planSupplierBankMatch({
      invoice,
      transaction: { amount: -5650, currency: 'SEK', amount_sek: null },
      accountingMethod: 'accrual',
      paymentRate: null,
    })
    expect(plan).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', newRemaining: 500 } })
  })

  it('refuses with neither rate rather than guess', () => {
    const plan = planSupplierBankMatch({
      invoice: { ...invoice, exchange_rate: null },
      transaction: { amount: -5650, currency: 'SEK', amount_sek: null },
      accountingMethod: 'accrual',
      paymentRate: null,
    })
    expect(plan).toMatchObject({ ok: false, code: 'SI_FX_RATE_MISSING' })
  })
})

describe('what a settlement clears', () => {
  it('a full settlement clears what 2440 carries', () => {
    const plan = planSupplierBankMatch({
      invoice,
      transaction: { amount: -11400, currency: 'SEK', amount_sek: null },
      accountingMethod: 'accrual',
      paymentRate,
      carriedSek: 11300.01,
    })
    expect(plan.ok && plan.plan.booking).toMatchObject({ paymentAmount: 11300.01, exchangeRateDifference: -99.99 })
  })

  it('a part payment clears its share of it', () => {
    const plan = planSupplierBankMatch({
      invoice,
      transaction: { amount: -5700, currency: 'SEK', amount_sek: null },
      accountingMethod: 'accrual',
      paymentRate,
      carriedSek: 11300.02,
    })
    expect(plan.ok && plan.plan.booking).toMatchObject({ paymentAmount: 5650.01 })
  })

  it('reads a foreign row by its SEK, and a row with none settles at the booked SEK as before', () => {
    const paid = planSupplierBankMatch({
      invoice,
      transaction: { amount: -500, currency: 'USD', amount_sek: -5700 },
      accountingMethod: 'accrual',
      paymentRate,
    })
    expect(paid).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', newRemaining: 500 } })
    const unknown = planSupplierBankMatch({
      invoice,
      transaction: { amount: -500, currency: 'USD', amount_sek: null },
      accountingMethod: 'accrual',
      paymentRate,
    })
    expect(unknown).toMatchObject({ ok: true, plan: { newStatus: 'paid' } })
  })

  it('reads a SEK invoice paid from a foreign account at rate 1', () => {
    const plan = planSupplierBankMatch({
      invoice: { ...invoice, currency: 'SEK', exchange_rate: null },
      transaction: { amount: -50, currency: 'EUR', amount_sek: -500 },
      accountingMethod: 'accrual',
      paymentRate: 1,
    })
    expect(plan).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', newRemaining: 500 } })
  })
})

describe('a payment above the remainder', () => {
  it('is a card rate on the supplier door up to the limit: 8 % over the mid rate settles', () => {
    expect(supplier(12312)).toMatchObject({ ok: true, plan: { newStatus: 'paid', newRemaining: 0 } })
  })

  it('is not this invoice past the limit: refused, never a kursförlust of 8 600 kr', () => {
    expect(supplier(20000)).toMatchObject({ ok: false, code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING' })
  })

  it('is refused on the customer door past the band, as before', () => {
    expect(customer(12312)).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
  })
})
