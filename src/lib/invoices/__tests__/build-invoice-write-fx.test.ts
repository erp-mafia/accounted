import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeCustomer } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'

/**
 * Currency leg of buildInvoiceWriteData.
 *
 * Deliberately runs the REAL lib/currency/riksbanken module: the bug this
 * covers was that the builder called fetchExchangeRate(currency) with neither
 * the supabase client nor a date, so the shared exchange_rates cache was never
 * consulted on either leg (read-through or 429 fallback) and every invoice was
 * stamped with TODAY's rate instead of the taxable event's. Mocking the module
 * away would hide exactly that. Only `fetch` and the supabase client are stubs.
 */

interface RecordedQuery {
  table: string
  op: 'select' | 'upsert'
  eq: Record<string, unknown>
  lte: Record<string, unknown>
  payload?: unknown
}

type QueryResult = { data: unknown; error: unknown }

function createRecordingSupabase(resolve: (q: RecordedQuery) => QueryResult) {
  const queries: RecordedQuery[] = []

  const from = (table: string) => {
    const q: RecordedQuery = { table, op: 'select', eq: {}, lte: {} }
    queries.push(q)

    const api: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const result = resolve(q)
            return (onFulfilled: (v: QueryResult) => void) => onFulfilled(result)
          }
          return (...args: unknown[]) => {
            if (prop === 'eq') q.eq[String(args[0])] = args[1]
            else if (prop === 'lte') q.lte[String(args[0])] = args[1]
            else if (prop === 'upsert') {
              q.op = 'upsert'
              q.payload = args[0]
            }
            return api
          }
        },
      },
    )
    return api
  }

  return { supabase: { from } as unknown as SupabaseClient, queries }
}

const baseInput: InvoiceWriteInput = {
  customer_id: 'customer-1',
  invoice_date: '2026-06-15',
  due_date: '2026-07-15',
  currency: 'EUR',
  items: [{ description: 'Konsult', quantity: 10, unit: 'tim', unit_price: 100, vat_rate: 0 }],
}

// EU business with a validated VAT number: reverse charge, 0% is the only
// allowed rate, so the FX assertions are not entangled with VAT rules.
const euCustomer = makeCustomer({ customer_type: 'eu_business', vat_number_validated: true })

function build(supabase: SupabaseClient, input: Partial<InvoiceWriteInput> = {}) {
  return buildInvoiceWriteData({
    supabase,
    companyId: 'company-1',
    customer: euCustomer,
    documentType: 'invoice',
    input: { ...baseInput, ...input },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildInvoiceWriteData exchange rate', () => {
  it('reads the taxable-event rate from the exchange_rates cache instead of calling Riksbanken', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { supabase, queries } = createRecordingSupabase((q) => {
      if (q.table === 'company_settings') return { data: { vat_registered: true }, error: null }
      if (q.table === 'exchange_rates') {
        return { data: { rate: 11.2345, observation_date: '2026-06-15' }, error: null }
      }
      return { data: null, error: null }
    })

    const result = await build(supabase)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.exchange_rate).toBe(11.2345)
    expect(result.invoiceFields.exchange_rate_date).toBe('2026-06-15')
    expect(result.invoiceFields.total_sek).toBeCloseTo(1000 * 11.2345, 6)

    // The client reached the cache at all: without it fetchExchangeRate never
    // touches exchange_rates and goes straight to the network.
    const cacheRead = queries.find((q) => q.table === 'exchange_rates')
    expect(cacheRead).toBeDefined()
    expect(cacheRead!.eq.currency).toBe('EUR')
    // The rate is looked up for the invoice date, not for "today".
    expect(cacheRead!.eq.rate_date).toBe('2026-06-15')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses delivery_date, the taxable event, when it differs from the invoice date', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { supabase, queries } = createRecordingSupabase((q) => {
      if (q.table === 'company_settings') return { data: { vat_registered: true }, error: null }
      if (q.table === 'exchange_rates') {
        return { data: { rate: 11.0, observation_date: '2026-05-20' }, error: null }
      }
      return { data: null, error: null }
    })

    const result = await build(supabase, { delivery_date: '2026-05-20' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cacheRead = queries.find((q) => q.table === 'exchange_rates')
    // ML 8 kap 21-23 §: the rate is the one at the taxable event (the delivery
    // date), not the invoice date, whenever the two differ.
    expect(cacheRead!.eq.rate_date).toBe('2026-05-20')
    expect(result.invoiceFields.exchange_rate_date).toBe('2026-05-20')
  })

  it('falls back to the latest cached observation when Riksbanken rate-limits', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '0' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    let exchangeRateCalls = 0
    const { supabase, queries } = createRecordingSupabase((q) => {
      if (q.table === 'company_settings') return { data: { vat_registered: true }, error: null }
      if (q.table === 'exchange_rates') {
        exchangeRateCalls += 1
        // 1st: exact-date read-through miss. 2nd: latest-on-or-before fallback.
        if (exchangeRateCalls === 1) return { data: null, error: null }
        return { data: { rate: 11.11, observation_date: '2026-06-12' }, error: null }
      }
      return { data: null, error: null }
    })

    const result = await build(supabase)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The regression: one transient 429 used to leave exchange_rate NULL
    // forever, and resolveSekAmount() then books 1 000 EUR as 1 000 kr.
    expect(result.invoiceFields.exchange_rate).toBe(11.11)
    expect(result.invoiceFields.exchange_rate_date).toBe('2026-06-12')
    const fallbackRead = queries.filter((q) => q.table === 'exchange_rates')[1]
    expect(fallbackRead.lte.rate_date).toBe('2026-06-15')
  })

  it('leaves the SEK columns null when neither Riksbanken nor the cache can answer', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '0' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { supabase } = createRecordingSupabase((q) => {
      if (q.table === 'company_settings') return { data: { vat_registered: true }, error: null }
      return { data: null, error: null }
    })

    const result = await build(supabase)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Never a made-up rate: the row stays repairable via
    // POST /api/invoices/{id}/refresh-exchange-rate.
    expect(result.invoiceFields.exchange_rate).toBeNull()
    expect(result.invoiceFields.total_sek).toBeNull()
  })

  it('never queries exchange_rates for a SEK invoice', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { supabase, queries } = createRecordingSupabase((q) => {
      if (q.table === 'company_settings') return { data: { vat_registered: true }, error: null }
      return { data: null, error: null }
    })

    const result = await build(supabase, { currency: 'SEK' })

    expect(result.ok).toBe(true)
    expect(queries.some((q) => q.table === 'exchange_rates')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('populates the SEK twin columns for a SEK invoice instead of leaving them NULL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { supabase } = createRecordingSupabase((q) => {
      if (q.table === 'company_settings') return { data: { vat_registered: true }, error: null }
      return { data: null, error: null }
    })

    const result = await build(supabase, { currency: 'SEK' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The staged-operations commit path writes total_sek = total for SEK
    // invoices (sekRate = 1); the web/REST path must produce the same row or
    // the SEK-reporting readers see two different shapes for the same invoice.
    expect(result.invoiceFields.exchange_rate).toBeNull()
    expect(result.invoiceFields.subtotal_sek).toBe(1000)
    expect(result.invoiceFields.vat_amount_sek).toBe(0)
    expect(result.invoiceFields.total_sek).toBe(1000)
  })

  it('rounds the SEK twins to the ore for a SEK invoice with float-dust line math', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { supabase } = createRecordingSupabase((q) => {
      if (q.table === 'company_settings') return { data: { vat_registered: true }, error: null }
      return { data: null, error: null }
    })

    const result = await build(supabase, {
      currency: 'SEK',
      items: [{ description: 'Konsult', quantity: 3, unit: 'tim', unit_price: 33.33, vat_rate: 0 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.subtotal_sek).toBe(99.99)
    expect(result.invoiceFields.total_sek).toBe(99.99)
  })
})
