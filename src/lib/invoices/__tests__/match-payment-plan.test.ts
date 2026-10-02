/**
 * planTransactionInvoiceMatch: the one payment plan the agent commit executor
 * and the MCP staging tools both run for a transaction-to-invoice match
 * (crm#253), so stage and approval cannot disagree on the overshoot guard,
 * the öre band, partial payments or FX.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFetchExchangeRate } = vi.hoisted(() => ({ mockFetchExchangeRate: vi.fn() }))
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: mockFetchExchangeRate }))

import { planTransactionInvoiceMatch } from '@/lib/invoices/match-payment-plan'

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

    // 1105 SEK = 100.4545 EUR: a sub-unit overshoot, still refused cross-currency.
    const over = await planTransactionInvoiceMatch(supabase, sekTx(1105), {
      currency: 'EUR',
      total: 100,
      paid_amount: 0,
      remaining_amount: 100,
    })
    expect(over).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING', currency: 'EUR', absorbsOre: false })
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
