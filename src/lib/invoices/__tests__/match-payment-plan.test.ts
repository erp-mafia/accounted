/**
 * planTransactionInvoiceMatch: the one payment plan the agent commit executor
 * and the MCP staging tools both run for a transaction-to-invoice match
 * (crm#253), so stage and approval cannot disagree on the overshoot guard,
 * the öre band, partial payments or FX.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFetchExchangeRate } = vi.hoisted(() => ({ mockFetchExchangeRate: vi.fn() }))
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: mockFetchExchangeRate }))

import { fxPaidInInvoiceCurrency, planMatchPayment, planTransactionInvoiceMatch } from '@/lib/invoices/match-payment-plan'

const supabase = {} as never

function sekTx(amount: number) {
  return { amount, amount_sek: null, currency: 'SEK', exchange_rate: null, date: '2026-09-30' }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('planTransactionInvoiceMatch: pure SEK', () => {
  it('settles an exact payment in full', async () => {
    const r = await planTransactionInvoiceMatch(supabase, sekTx(1000), {
      currency: 'SEK',
      total: 1000,
      paid_amount: 0,
      remaining_amount: 1000,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fx).toEqual({ required: false })
      expect(r.paidAmount).toBe(1000)
      expect(r.plan).toMatchObject({ newStatus: 'paid', newRemaining: 0, oreSettled: false })
    }
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('records a partial payment as partially_paid', async () => {
    const r = await planTransactionInvoiceMatch(supabase, sekTx(400), {
      currency: 'SEK',
      total: 1000,
      paid_amount: 0,
      remaining_amount: 1000,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan).toMatchObject({ newStatus: 'partially_paid', newPaidAmount: 400, newRemaining: 600 })
  })

  it('absorbs a sub-krona overshoot as öresavrundning and settles in full', async () => {
    const r = await planTransactionInvoiceMatch(supabase, sekTx(813), {
      currency: 'SEK',
      total: 812.40,
      paid_amount: 0,
      remaining_amount: 812.40,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan).toMatchObject({ newStatus: 'paid', newPaidAmount: 812.40, oreSettled: true })
  })

  it('rejects an overshoot of 1 kr or more with the amounts', async () => {
    const r = await planTransactionInvoiceMatch(supabase, sekTx(814), {
      currency: 'SEK',
      total: 812.40,
      paid_amount: 0,
      remaining_amount: 812.40,
    })
    expect(r).toEqual({
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
      currency: 'SEK',
      absorbsOre: true,
      details: { transaction_amount: 814, remaining_amount: 812.40, excess: 1.60 },
    })
  })

  it('rejects an exact 1.00 overshoot (the band is strictly under 1 kr)', async () => {
    const r = await planTransactionInvoiceMatch(supabase, sekTx(1001), {
      currency: 'SEK',
      total: 1000,
      paid_amount: 0,
      remaining_amount: 1000,
    })
    expect(r.ok).toBe(false)
  })

  it('measures the overshoot against the remaining amount after earlier partial payments', async () => {
    const invoice = { currency: 'SEK', total: 1000, paid_amount: 600, remaining_amount: 400 }
    const over = await planTransactionInvoiceMatch(supabase, sekTx(401.5), invoice)
    expect(over).toMatchObject({ ok: false, details: { remaining_amount: 400, excess: 1.5 } })

    const settles = await planTransactionInvoiceMatch(supabase, sekTx(400), invoice)
    expect(settles.ok).toBe(true)
    if (settles.ok) expect(settles.plan).toMatchObject({ newStatus: 'paid', newPaidAmount: 1000 })
  })
})

describe('planTransactionInvoiceMatch: cross-currency', () => {
  it('converts the SEK payment at the payment-day rate and keeps the strict guard (no öre band)', async () => {
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11, date: '2026-09-30' })
    const ok = await planTransactionInvoiceMatch(supabase, sekTx(1100), {
      currency: 'EUR',
      total: 100,
      paid_amount: 0,
      remaining_amount: 100,
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.fx).toEqual({ required: true, rate: 11, paidInInvoiceCurrency: 100 })
      expect(ok.paidAmount).toBe(100)
    }
    expect(mockFetchExchangeRate).toHaveBeenCalledWith('EUR', new Date('2026-09-30'), supabase)

    // 1150 SEK = 104.5455 EUR: an overshoot outside the full-settlement band,
    // still refused cross-currency (no öre band).
    const over = await planTransactionInvoiceMatch(supabase, sekTx(1150), {
      currency: 'EUR',
      total: 100,
      paid_amount: 0,
      remaining_amount: 100,
    })
    expect(over).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING', currency: 'EUR', absorbsOre: false })
  })

  // PH 227: a 8 800 EUR invoice booked at 11.1145 (97 807,60 kr) paid in full
  // reached the bank as 97 419,96 kr. At Riksbanken's 11.1385 that read as
  // 8 746,24 EUR, a partial payment with a phantom kursvinst. The bank's rate
  // is never the mid rate: within the band the payment settles the invoice.
  it('settles in full when the converted payment lies within the band of the remaining amount', async () => {
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.1385, date: '2026-10-26' })
    const r = await planTransactionInvoiceMatch(supabase, sekTx(97419.96), {
      currency: 'EUR',
      total: 8800,
      paid_amount: 0,
      remaining_amount: 8800,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fx).toEqual({ required: true, rate: 11.1385, paidInInvoiceCurrency: 8800 })
      expect(r.paidAmount).toBe(8800)
      expect(r.plan).toMatchObject({ newStatus: 'paid', newRemaining: 0 })
    }

    // A little over the remaining (the bank's rate beat the mid rate) settles too.
    const over = await planTransactionInvoiceMatch(supabase, sekTx(1115), {
      currency: 'EUR',
      total: 100,
      paid_amount: 0,
      remaining_amount: 100,
    })
    expect(over).toMatchObject({ ok: true, paidAmount: 100, plan: { newStatus: 'paid' } })
  })

  it('keeps a payment outside the band a partial payment, measured against the remaining amount', async () => {
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11, date: '2026-09-30' })
    // 1000 SEK = 90.9091 EUR of 100: 9 % short, a real partial payment.
    const partial = await planTransactionInvoiceMatch(supabase, sekTx(1000), {
      currency: 'EUR',
      total: 100,
      paid_amount: 0,
      remaining_amount: 100,
    })
    expect(partial).toMatchObject({ ok: true, paidAmount: 90.9091, plan: { newStatus: 'partially_paid' } })

    // The second half of an invoice already half paid: 545 SEK = 49.5455 EUR
    // of the 50 still owed settles it.
    const rest = await planTransactionInvoiceMatch(supabase, sekTx(545), {
      currency: 'EUR',
      total: 100,
      paid_amount: 50,
      remaining_amount: 50,
    })
    expect(rest).toMatchObject({ ok: true, paidAmount: 50, plan: { newStatus: 'paid', newRemaining: 0 } })
  })

  it('reports an unavailable rate instead of guessing one', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)
    const r = await planTransactionInvoiceMatch(supabase, sekTx(1100), {
      currency: 'EUR',
      total: 100,
      remaining_amount: 100,
    })
    expect(r).toEqual({ ok: false, code: 'MATCH_INVOICE_FX_RATE_UNAVAILABLE' })
  })

  it('refuses a foreign-currency transaction with neither amount_sek nor a rate', async () => {
    const r = await planTransactionInvoiceMatch(
      supabase,
      { amount: 100, amount_sek: null, currency: 'EUR', exchange_rate: null, date: '2026-09-30' },
      { currency: 'EUR', total: 100, remaining_amount: 100 },
    )
    expect(r).toEqual({ ok: false, code: 'MATCH_INVOICE_TX_FX_RATE_MISSING' })
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })
})

describe('planTransactionInvoiceMatch: overpaymentAccount (crm#253)', () => {
  const invoice = { currency: 'SEK', total: 337.5, paid_amount: 0, remaining_amount: 337.5 }

  it('settles exactly the remaining and hands the excess to 3740 under the cap', async () => {
    const r = await planTransactionInvoiceMatch(supabase, sekTx(340), invoice, { overpaymentAccount: '3740' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.overpayment).toEqual({ account: '3740', amount: 2.5 })
      expect(r.paidAmount).toBe(337.5)
      expect(r.plan).toMatchObject({ newStatus: 'paid', newPaidAmount: 337.5, newRemaining: 0, oreSettled: false })
    }
  })

  it('refuses 3740 at the cap and takes any excess on 2420', async () => {
    const capped = await planTransactionInvoiceMatch(supabase, sekTx(347.5), invoice, { overpaymentAccount: '3740' })
    expect(capped).toMatchObject({ ok: false, code: 'MATCH_OVERPAYMENT_ROUNDING_CAP', details: { excess: 10 } })

    const advance = await planTransactionInvoiceMatch(supabase, sekTx(5000), invoice, { overpaymentAccount: '2420' })
    expect(advance).toMatchObject({ ok: true, overpayment: { account: '2420', amount: 4662.5 } })
  })

  it('books no overpayment without an account, for a sub-krona overshoot or for an unknown account', async () => {
    expect(await planTransactionInvoiceMatch(supabase, sekTx(340), invoice)).toMatchObject({
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
    })
    expect(await planTransactionInvoiceMatch(supabase, sekTx(338), invoice, { overpaymentAccount: '2420' })).toMatchObject({
      ok: true,
      overpayment: null,
      plan: { oreSettled: true },
    })
    expect(await planTransactionInvoiceMatch(supabase, sekTx(340), invoice, { overpaymentAccount: '3990' })).toMatchObject({
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
    })
  })

  it('keeps refusing a foreign overshoot with an account named', async () => {
    const r = await planTransactionInvoiceMatch(
      supabase,
      { amount: 105, amount_sek: 1207.5, currency: 'EUR', exchange_rate: 11.5, date: '2026-09-30' },
      { currency: 'EUR', total: 100, paid_amount: 0, remaining_amount: 100 },
      { overpaymentAccount: '2420' },
    )
    expect(r).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING', absorbsOre: false })
  })
})

// The step after FX, run as-is by the dashboard match route and its preview
// (crm#1045): the same outcome as the agent's plan for the same amounts.
describe('planMatchPayment', () => {
  const invoice = { currency: 'SEK', total: 837.5, paid_amount: 0, remaining_amount: 418.75 }

  it('refuses a krona or more over without an account, naming the excess', () => {
    expect(planMatchPayment(invoice, 420, { pureSek: true })).toEqual({
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
      currency: 'SEK',
      absorbsOre: true,
      details: { transaction_amount: 420, remaining_amount: 418.75, excess: 1.25 },
    })
  })

  it('settles the remaining amount and hands the excess to the named account', () => {
    const r = planMatchPayment(invoice, 420, { pureSek: true, overpaymentAccount: '3740' })
    expect(r).toMatchObject({
      ok: true,
      paidAmount: 418.75,
      plan: { newPaidAmount: 418.75, newRemaining: 0, isFullyPaid: true, newStatus: 'paid' },
      overpayment: { account: '3740', amount: 1.25 },
    })
  })

  it('agrees with planTransactionInvoiceMatch on the same SEK amounts', async () => {
    const step = planMatchPayment(invoice, 420, { pureSek: true, overpaymentAccount: '2420' })
    const plan = await planTransactionInvoiceMatch(supabase, sekTx(420), invoice, { overpaymentAccount: '2420' })
    expect(plan).toEqual({ ...step, fx: { required: false } })
  })
})

// crm#1364: a card payment the customer made in full, paid out to the bank
// net of the payment provider's fee. Named, the fee settles the invoice.
describe('planTransactionInvoiceMatch: feeAccount (crm#1364)', () => {
  const invoice = { currency: 'SEK', total: 10000, paid_amount: 0, remaining_amount: 10000 }

  it('settles the invoice in full and hands the shortfall to 6570 as the fee', async () => {
    const r = await planTransactionInvoiceMatch(supabase, sekTx(9809.5), invoice, { feeAccount: '6570' })
    expect(r).toMatchObject({
      ok: true,
      paidAmount: 10000,
      plan: { newStatus: 'paid', newPaidAmount: 10000, newRemaining: 0, isFullyPaid: true, oreSettled: false },
      overpayment: null,
      fee: { account: '6570', amount: 190.5 },
    })
  })

  it('stays a partial payment without the account, and books no fee when the payment settles anyway', async () => {
    expect(await planTransactionInvoiceMatch(supabase, sekTx(9809.5), invoice)).toMatchObject({
      ok: true,
      fee: null,
      plan: { newStatus: 'partially_paid', newPaidAmount: 9809.5, newRemaining: 190.5 },
    })
    // Exact, and a sub-krona gap (öresavrundning on 3740): nothing for 6570.
    expect(await planTransactionInvoiceMatch(supabase, sekTx(10000), invoice, { feeAccount: '6570' })).toMatchObject({
      ok: true,
      fee: null,
      plan: { newStatus: 'paid' },
    })
    expect(await planTransactionInvoiceMatch(supabase, sekTx(9999.5), invoice, { feeAccount: '6570' })).toMatchObject({
      ok: true,
      fee: null,
      plan: { newStatus: 'paid', oreSettled: true },
    })
  })

  it('refuses a shortfall of a tenth or more of the remaining amount: that is a partial payment, not a fee', async () => {
    expect(await planTransactionInvoiceMatch(supabase, sekTx(9000), invoice, { feeAccount: '6570' })).toEqual({
      ok: false,
      code: 'MATCH_PAYMENT_FEE_NOT_ALLOWED',
      currency: 'SEK',
      details: { transaction_amount: 9000, remaining_amount: 10000, shortfall: 1000, reason: 'cap' },
    })
    // Just under the cap is a fee.
    expect(await planTransactionInvoiceMatch(supabase, sekTx(9000.01), invoice, { feeAccount: '6570' })).toMatchObject({
      ok: true,
      fee: { account: '6570', amount: 999.99 },
    })
  })

  it('measures the fee against what is still owed after earlier partial payments', async () => {
    const partly = { currency: 'SEK', total: 10000, paid_amount: 6000, remaining_amount: 4000 }
    expect(await planTransactionInvoiceMatch(supabase, sekTx(3900), partly, { feeAccount: '6570' })).toMatchObject({
      ok: true,
      paidAmount: 4000,
      plan: { newPaidAmount: 10000, newRemaining: 0, newStatus: 'paid' },
      fee: { account: '6570', amount: 100 },
    })
  })

  it('refuses a fee on a cross-currency match and ignores an unknown account', async () => {
    mockFetchExchangeRate.mockResolvedValueOnce({ rate: 11.5, date: '2026-09-30' })
    // 1100 SEK = 95.65 EUR: outside the full-settlement band, so a shortfall.
    const fx = await planTransactionInvoiceMatch(
      supabase,
      sekTx(1100),
      { currency: 'EUR', total: 100, paid_amount: 0, remaining_amount: 100 },
      { feeAccount: '6570' },
    )
    expect(fx).toMatchObject({ ok: false, code: 'MATCH_PAYMENT_FEE_NOT_ALLOWED', details: { reason: 'currency' } })

    expect(await planTransactionInvoiceMatch(supabase, sekTx(9809.5), invoice, { feeAccount: '6064' })).toMatchObject({
      ok: true,
      fee: null,
      plan: { newStatus: 'partially_paid' },
    })
  })

  it('agrees with planMatchPayment on the same SEK amounts', async () => {
    const step = planMatchPayment(invoice, 9809.5, { pureSek: true, feeAccount: '6570' })
    const plan = await planTransactionInvoiceMatch(supabase, sekTx(9809.5), invoice, { feeAccount: '6570' })
    expect(plan).toEqual({ ...step, fx: { required: false } })
  })
})

describe('fxPaidInInvoiceCurrency', () => {
  const invoice = { total: 8800, paid_amount: 0, remaining_amount: 8800 }

  it('snaps to the remaining amount inside the band, either side', () => {
    expect(fxPaidInInvoiceCurrency(97419.96, 11.1385, invoice)).toBe(8800)
    expect(fxPaidInInvoiceCurrency(8800 * 11.1385 * 1.019, 11.1385, invoice)).toBe(8800)
  })

  it('converts at the rate to four decimals outside the band', () => {
    expect(fxPaidInInvoiceCurrency(8800 * 11 * 0.97, 11, invoice)).toBe(8536)
    expect(fxPaidInInvoiceCurrency(1000, 11, invoice)).toBe(90.9091)
  })

  it('falls back to total minus paid when remaining_amount is not on the row', () => {
    expect(fxPaidInInvoiceCurrency(545, 11, { total: 100, paid_amount: 50 })).toBe(50)
  })

  it('never snaps an invoice with nothing left', () => {
    expect(fxPaidInInvoiceCurrency(11, 11, { total: 100, paid_amount: 100, remaining_amount: 0 })).toBe(1)
  })
})
