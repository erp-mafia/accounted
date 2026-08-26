import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PartyDto, SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

/**
 * Guards the SEK conversion of migrated invoices.
 *
 * The provider DTOs carry NO exchange rate and NO SEK amount, only a currency
 * code and amounts already expressed in it. The mapper used to write
 * `exchange_rate: dto.currencyCode === 'SEK' ? null : null`: a ternary that
 * returned null on BOTH branches, so every foreign-currency invoice the
 * migration imported arrived unconverted, together with null subtotal_sek /
 * vat_amount_sek / total_sek.
 *
 * An imported invoice is räkenskapsinformation (BFL 7 kap): its SEK value is
 * part of the record. So the rate must come from the invoice's OWN issue date
 * (not today), and when no rate can be established the invoice must be
 * REPORTED, never silently nulled and never posted at a fabricated 1:1.
 */

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn(),
}))

import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { buildFxRateIndex, mapSalesInvoice, mapSupplierInvoice } from '../lib/entity-mapper'

const party: PartyDto = { name: 'Motpart AB', identifications: [] }

function salesDto(over: { currencyCode?: string; issueDate?: string } = {}): SalesInvoiceDto {
  const currencyCode = over.currencyCode ?? 'SEK'
  return {
    id: 'inv-1',
    invoiceNumber: 'F-100',
    issueDate: over.issueDate ?? '2024-03-15',
    dueDate: '2024-04-15',
    currencyCode,
    status: 'sent',
    supplier: party,
    customer: party,
    lines: [
      {
        id: '1',
        description: 'Konsultarvode',
        lineExtensionAmount: { value: 1000, currencyCode },
        taxPercent: 25,
        taxAmount: { value: 250, currencyCode },
      },
    ],
    taxTotal: { taxAmount: { value: 250, currencyCode } },
    legalMonetaryTotal: {
      lineExtensionAmount: { value: 1000, currencyCode },
      payableAmount: { value: 1250, currencyCode },
    },
    paymentStatus: { paid: false, balance: { value: 1250, currencyCode } },
  }
}

function supplierDto(over: { currencyCode?: string; issueDate?: string } = {}): SupplierInvoiceDto {
  const currencyCode = over.currencyCode ?? 'SEK'
  return {
    id: 'sinv-1',
    invoiceNumber: 'L-200',
    issueDate: over.issueDate ?? '2024-03-15',
    dueDate: '2024-04-15',
    currencyCode,
    status: 'booked',
    supplier: party,
    buyer: party,
    lines: [
      {
        id: '1',
        description: 'Licens',
        lineExtensionAmount: { value: 1000, currencyCode },
        taxPercent: 25,
        taxAmount: { value: 250, currencyCode },
      },
    ],
    taxTotal: { taxAmount: { value: 250, currencyCode } },
    legalMonetaryTotal: {
      lineExtensionAmount: { value: 1000, currencyCode },
      payableAmount: { value: 1250, currencyCode },
    },
    paymentStatus: { paid: false, balance: { value: 1250, currencyCode } },
  }
}

const supabase = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('invoice item VAT-rate units', () => {
  it('keeps customer items in percent and supplier items in decimal fractions', () => {
    const sales = mapSalesInvoice(salesDto(), 'user-1', 'company-1', 'customer-1')
    const supplier = mapSupplierInvoice(supplierDto(), 'user-1', 'company-1', 'supplier-1')

    expect(sales.items[0]?.vat_rate).toBe(25)
    expect(supplier.items[0]?.vat_rate).toBe(0.25)
  })

  it('preserves a foreign supplier rate while converting its unit', () => {
    const dto = supplierDto()
    dto.lines[0]!.taxPercent = 19

    const supplier = mapSupplierInvoice(dto, 'user-1', 'company-1', 'supplier-1')

    expect(supplier.items[0]?.vat_rate).toBe(0.19)
  })
})

describe('buildFxRateIndex', () => {
  it('fetches the rate for each document DATE, not today, and caches per pair', async () => {
    ;(fetchExchangeRate as Mock).mockImplementation(async (currency: string, date: Date) => ({
      currency,
      rate: 11.5,
      date: date.toISOString().split('T')[0],
    }))

    const index = await buildFxRateIndex(supabase, [
      { currencyCode: 'EUR', issueDate: '2024-03-15' },
      // Same (currency, date) pair: must NOT trigger a second fetch.
      { currencyCode: 'EUR', issueDate: '2024-03-15' },
      { currencyCode: 'EUR', issueDate: '2022-11-02' },
      // SEK needs no rate at all.
      { currencyCode: 'SEK', issueDate: '2024-03-15' },
    ])

    expect(fetchExchangeRate).toHaveBeenCalledTimes(2)
    // The document's own date is what is asked for.
    const askedDates = (fetchExchangeRate as Mock).mock.calls
      .map((c) => (c[1] as Date).toISOString().split('T')[0])
      .sort()
    expect(askedDates).toEqual(['2022-11-02', '2024-03-15'])
    // The supabase client is passed so the exchange_rates cache is consulted.
    expect((fetchExchangeRate as Mock).mock.calls[0][2]).toBe(supabase)

    expect(index.get('EUR|2024-03-15')?.rate).toBe(11.5)
    expect(index.get('EUR|2022-11-02')?.rate).toBe(11.5)
  })

  it('leaves a pair unset when the rate cannot be fetched: never a made-up rate', async () => {
    ;(fetchExchangeRate as Mock).mockResolvedValue(null)

    const index = await buildFxRateIndex(supabase, [{ currencyCode: 'EUR', issueDate: '2024-03-15' }])

    expect(index.size).toBe(0)
  })

  it('skips currencies with no Riksbanken series instead of fetching them', async () => {
    const index = await buildFxRateIndex(supabase, [{ currencyCode: 'JPY', issueDate: '2024-03-15' }])

    expect(fetchExchangeRate).not.toHaveBeenCalled()
    expect(index.size).toBe(0)
  })
})

describe.each([
  ['mapSalesInvoice', (dto: SalesInvoiceDto, fx?: Map<string, never>) =>
    mapSalesInvoice(dto, 'user-1', 'company-1', 'customer-1', fx as never), salesDto],
  ['mapSupplierInvoice', (dto: SupplierInvoiceDto, fx?: Map<string, never>) =>
    mapSupplierInvoice(dto, 'user-1', 'company-1', 'supplier-1', fx as never), supplierDto],
] as const)('%s: SEK conversion', (_name, map, makeDto) => {
  it('SEK invoice: no exchange rate, SEK amounts equal the invoice amounts', () => {
    // A domestic invoice has no rate to record; that null is honest, and the
    // *_sek columns still carry the value.
    const { invoice, fxUnresolved } = map(makeDto({ currencyCode: 'SEK' }) as never)

    expect(invoice.exchange_rate).toBeNull()
    expect(invoice.exchange_rate_date).toBeNull()
    expect(invoice.subtotal_sek).toBe(1000)
    expect(invoice.vat_amount_sek).toBe(250)
    expect(invoice.total_sek).toBe(1250)
    expect(fxUnresolved).toBeNull()
  })

  it('EUR invoice with a resolved rate: rate and SEK amounts are populated', () => {
    const fx = new Map([
      ['EUR|2024-03-15', { currency: 'EUR', rate: 11.32, date: '2024-03-15' }],
    ])

    const { invoice, fxUnresolved } = map(
      makeDto({ currencyCode: 'EUR', issueDate: '2024-03-15' }) as never,
      fx as never
    )

    expect(invoice.currency).toBe('EUR')
    expect(invoice.exchange_rate).toBe(11.32)
    expect(invoice.exchange_rate_date).toBe('2024-03-15')
    // Rounded to öre through the mapper's round2 helper, never toFixed.
    expect(invoice.subtotal_sek).toBe(11320)
    expect(invoice.vat_amount_sek).toBe(2830)
    expect(invoice.total_sek).toBe(14150)
    // Foreign-currency amounts themselves stay in the invoice currency.
    expect(invoice.subtotal).toBe(1000)
    expect(invoice.total).toBe(1250)
    expect(fxUnresolved).toBeNull()
  })

  it('uses the rate for the invoice DATE, not another date in the index', () => {
    const fx = new Map([
      ['EUR|2024-03-15', { currency: 'EUR', rate: 11.32, date: '2024-03-15' }],
      ['EUR|2022-11-02', { currency: 'EUR', rate: 10.75, date: '2022-11-02' }],
    ])

    const { invoice } = map(
      makeDto({ currencyCode: 'EUR', issueDate: '2022-11-02' }) as never,
      fx as never
    )

    expect(invoice.exchange_rate).toBe(10.75)
    expect(invoice.total_sek).toBe(13437.5)
  })

  it('EUR invoice with no obtainable rate: reported, not silently nulled', () => {
    const { invoice, fxUnresolved } = map(
      makeDto({ currencyCode: 'EUR', issueDate: '2024-03-15' }) as never,
      new Map() as never
    )

    // Still imported (the record is räkenskapsinformation) but explicitly
    // unconverted, so the booking paths refuse it instead of posting at 1:1.
    expect(invoice.exchange_rate).toBeNull()
    expect(invoice.subtotal_sek).toBeNull()
    expect(invoice.vat_amount_sek).toBeNull()
    expect(invoice.total_sek).toBeNull()
    expect(fxUnresolved).toEqual({ currency: 'EUR', date: '2024-03-15', reason: 'rate_unavailable' })
  })

  it('currency with no rate source at all is reported as unsupported', () => {
    const { invoice, fxUnresolved } = map(
      makeDto({ currencyCode: 'JPY', issueDate: '2024-03-15' }) as never,
      new Map() as never
    )

    expect(invoice.exchange_rate).toBeNull()
    expect(invoice.total_sek).toBeNull()
    expect(fxUnresolved).toEqual({
      currency: 'JPY',
      date: '2024-03-15',
      reason: 'unsupported_currency',
    })
  })

  it('never converts a foreign invoice when no rate index is supplied', () => {
    // The regression this locks: a caller that forgets to resolve rates must
    // get a REPORT, never a 1:1 conversion.
    const { invoice, fxUnresolved } = map(makeDto({ currencyCode: 'EUR' }) as never)

    expect(invoice.exchange_rate).toBeNull()
    expect(invoice.total_sek).toBeNull()
    expect(fxUnresolved?.reason).toBe('rate_unavailable')
  })
})
