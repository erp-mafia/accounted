import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return { ...actual, fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args) }
})

import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'

// The resolver only ever hands the client through to fetchExchangeRate, so a
// sentinel is enough to prove it was passed (that is what turns the shared
// exchange_rates table into a read-through cache).
const supabase = { sentinel: true } as unknown as SupabaseClient

describe('resolveSupplierInvoiceExchangeRate', () => {
  beforeEach(() => {
    mockFetchExchangeRate.mockReset()
  })

  it('treats an omitted currency as SEK at rate 1 with no stored exchange_rate', async () => {
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      invoiceDate: '2026-03-02',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rate).toEqual({
      currency: 'SEK',
      rate: 1,
      exchangeRate: null,
      exchangeRateDate: null,
      source: 'sek',
    })
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('ignores a rate supplied alongside SEK: 1 SEK is 1 SEK, not a kurs', async () => {
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'SEK',
      invoiceDate: '2026-03-02',
      suppliedRate: 11.5,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rate.rate).toBe(1)
    expect(result.rate.exchangeRate).toBeNull()
  })

  it('trusts a positive caller-supplied rate on a foreign invoice', async () => {
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'EUR',
      invoiceDate: '2026-03-02',
      suppliedRate: 11.37,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rate.rate).toBe(11.37)
    expect(result.rate.exchangeRate).toBe(11.37)
    // We cannot vouch for the source of a hand-entered rate, so no
    // observation date is claimed.
    expect(result.rate.exchangeRateDate).toBeNull()
    expect(result.rate.source).toBe('supplied')
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('fetches for the invoice date, passing the supabase client', async () => {
    mockFetchExchangeRate.mockResolvedValue({ currency: 'USD', rate: 10.4, date: '2026-02-27' })

    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'USD',
      invoiceDate: '2026-03-02',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rate.rate).toBe(10.4)
    expect(result.rate.exchangeRateDate).toBe('2026-02-27')
    expect(result.rate.source).toBe('fetched')

    const [currencyArg, dateArg, clientArg] = mockFetchExchangeRate.mock.calls[0]
    expect(currencyArg).toBe('USD')
    expect((dateArg as Date).toISOString().slice(0, 10)).toBe('2026-03-02')
    expect(clientArg).toBe(supabase)
  })

  it('refuses when Riksbanken yields nothing rather than guessing a rate', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)

    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'GBP',
      invoiceDate: '2026-03-02',
    })

    expect(result).toEqual({ ok: false, currency: 'GBP', invoiceDate: '2026-03-02' })
  })

  it('refuses when the fetch throws instead of returning null', async () => {
    mockFetchExchangeRate.mockRejectedValue(new Error('boom'))

    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'NOK',
      invoiceDate: '2026-03-02',
    })

    expect(result.ok).toBe(false)
  })

  it('refuses a currency with no Riksbanken series instead of storing it unconverted', async () => {
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'JPY',
      invoiceDate: '2026-03-02',
    })

    expect(result.ok).toBe(false)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('falls back to a supplied rate for an unsupported currency', async () => {
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'JPY',
      invoiceDate: '2026-03-02',
      suppliedRate: 0.072,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rate.rate).toBe(0.072)
  })

  it('refuses an implausibly large supplied rate instead of storing it', async () => {
    // Same bound as lib/bookkeeping/invoice-payment-lines.ts and the
    // match_batch_allocate RPC (0 < rate < 100000): a rate that far out is as
    // unusable as NULL. Refused, not silently replaced by a fetched rate: the
    // caller stated a rate and must get it bounced back for correction.
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'EUR',
      invoiceDate: '2026-03-02',
      suppliedRate: 100000,
    })

    expect(result).toEqual({ ok: false, currency: 'EUR', invoiceDate: '2026-03-02' })
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('still trusts a large supplied rate just below the plausibility bound', async () => {
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'EUR',
      invoiceDate: '2026-03-02',
      suppliedRate: 99999.9999,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rate.rate).toBe(99999.9999)
    expect(result.rate.source).toBe('supplied')
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('rejects a non-positive supplied rate and falls through to the fetch', async () => {
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.1, date: '2026-03-02' })

    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'EUR',
      invoiceDate: '2026-03-02',
      suppliedRate: 0,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rate.rate).toBe(11.1)
    expect(result.rate.source).toBe('fetched')
  })

  it('refuses a malformed invoice date without calling out to Riksbanken', async () => {
    const result = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: 'EUR',
      invoiceDate: 'not-a-date',
    })

    expect(result.ok).toBe(false)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })
})

describe('supplierInvoiceSekAmounts', () => {
  const sekRate = {
    currency: 'SEK',
    rate: 1,
    exchangeRate: null,
    exchangeRateDate: null,
    source: 'sek' as const,
  }

  it('mirrors the invoice amounts for a SEK invoice', () => {
    expect(
      supplierInvoiceSekAmounts(sekRate, { subtotal: 1000, vatAmount: 250, total: 1250 }),
    ).toEqual({ subtotal_sek: 1000, vat_amount_sek: 250, total_sek: 1250 })
  })

  it('translates every column at the same rate', () => {
    expect(
      supplierInvoiceSekAmounts(
        {
          currency: 'EUR',
          rate: 11.5,
          exchangeRate: 11.5,
          exchangeRateDate: '2026-03-02',
          source: 'fetched',
        },
        { subtotal: 1000, vatAmount: 250, total: 1250 },
      ),
    ).toEqual({ subtotal_sek: 11500, vat_amount_sek: 2875, total_sek: 14375 })
  })

  it('rounds to öre with roundOre, not the naive half-value form', () => {
    // 0.1 * 10.05 = 1.0049999999999999 in IEEE-754; the naive
    // Math.round(x*100)/100 drops it to 1.00.
    const result = supplierInvoiceSekAmounts(
      {
        currency: 'USD',
        rate: 10.05,
        exchangeRate: 10.05,
        exchangeRateDate: null,
        source: 'supplied',
      },
      { subtotal: 0.1, vatAmount: 0.1, total: 0.2 },
    )
    expect(result.subtotal_sek).toBe(1.01)
    expect(result.total_sek).toBe(2.01)
  })
})
