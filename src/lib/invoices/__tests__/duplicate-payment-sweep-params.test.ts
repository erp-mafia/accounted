/**
 * The exact query string the duplicate-payment sweep puts on the wire.
 *
 * The recording stubs elsewhere in this directory see which builder methods
 * were called; they cannot see what postgrest-js turns those calls into. This
 * file runs the REAL supabase-js / postgrest-js builder over a fake fetch and
 * reads the URL back, so that a future edit which reintroduces a second
 * `.or()` (and with it a second `or=` parameter whose handling by PostgREST
 * this repo never proved) fails here rather than in production.
 */
import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import {
  findDuplicatePaymentCandidatesForInvoice,
  findDuplicatePaymentCandidatesForSupplierInvoice,
} from '@/lib/invoices/duplicate-payment-candidates'

/**
 * createClient eagerly resolves a WebSocket implementation for realtime, which
 * Node 20 (CI) does not ship. Nothing here subscribes, so an inert class is
 * enough; same trick as tests/tool-pg/client.ts.
 */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('realtime is not used by this test')
  }
}

function createCapturingClient() {
  const urls: URL[] = []
  const fakeFetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(new URL(url))
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createClient('http://postgrest.invalid', 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: UnusedRealtimeTransport as never },
    global: { fetch: fakeFetch as typeof fetch },
  })
  return { client, urls }
}

const SEK_HI3G =
  '(and(or(currency.is.null,currency.eq.SEK),or(merchant_name.ilike.*hi3g*,description.ilike.*hi3g*)))'
const EUR_HI3G =
  '(and(or(currency.eq.EUR),or(merchant_name.ilike.*hi3g*,description.ilike.*hi3g*)))'

describe('duplicate-payment sweep: the query string on the wire', () => {
  it('supplier side, SEK invoice: one request, exactly one or= parameter carrying currency AND name probe', async () => {
    const { client, urls } = createCapturingClient()

    await findDuplicatePaymentCandidatesForSupplierInvoice(client, {
      companyId: '11111111-1111-4111-8111-111111111111',
      invoice: {
        supplier_invoice_number: '4471023987',
        supplier_name: 'Hi3G Access AB',
        currency: 'SEK',
        total: 12500,
        total_sek: 12500,
        exchange_rate: null,
      },
      paymentAmount: 12500,
      paymentDate: '2026-09-01',
    })

    expect(urls).toHaveLength(1)
    const params = urls[0].searchParams
    expect(urls[0].pathname).toMatch(/\/transactions$/)
    // The whole point: ONE `or` key. A second one is the repeated-key shape.
    expect(params.getAll('or')).toEqual([SEK_HI3G])
    // The band and the direction are ordinary ANDed filters on the same request.
    expect(params.getAll('amount')).toEqual(['lt.0', 'gte.-12750', 'lte.-12250'])
    expect(params.get('is_business')).toBe('eq.true')
    expect(params.get('supplier_invoice_id')).toBe('is.null')
    expect(params.get('invoice_id')).toBe('is.null')
    expect(params.get('company_id')).toBe('eq.11111111-1111-4111-8111-111111111111')
  })

  it('customer side, EUR invoice with a rate: two requests (EUR, SEK), each with exactly one or= parameter', async () => {
    const { client, urls } = createCapturingClient()

    await findDuplicatePaymentCandidatesForInvoice(client, {
      companyId: '11111111-1111-4111-8111-111111111111',
      invoice: {
        invoice_number: '2026-0042',
        customer_name: 'Hi3G Access AB',
        currency: 'EUR',
        total: 1000,
        total_sek: 11500,
        exchange_rate: 11.5,
      },
      paymentAmount: 1000,
      paymentDate: '2026-09-01',
    })

    // No aggregate sweep for a foreign-currency invoice: the two currency
    // sweeps are the whole conversation.
    expect(urls).toHaveLength(2)
    expect(urls[0].searchParams.getAll('or')).toEqual([EUR_HI3G])
    expect(urls[0].searchParams.getAll('amount')).toEqual(['gt.0', 'gte.980', 'lte.1020'])
    expect(urls[1].searchParams.getAll('or')).toEqual([SEK_HI3G])
    expect(urls[1].searchParams.getAll('amount')).toEqual(['gt.0', 'gte.11270', 'lte.11730'])
  })

  it('never sends the needle with LIKE or DSL metacharacters, whatever the counterparty is called', async () => {
    const { client, urls } = createCapturingClient()

    await findDuplicatePaymentCandidatesForSupplierInvoice(client, {
      companyId: '11111111-1111-4111-8111-111111111111',
      invoice: {
        supplier_invoice_number: null,
        supplier_name: 'Acme,fake.eq.true 50%_Off (AB)',
        currency: 'SEK',
        total: 100,
        total_sek: 100,
        exchange_rate: null,
      },
      paymentAmount: 100,
      paymentDate: '2026-09-01',
    })

    expect(urls).toHaveLength(1)
    expect(urls[0].searchParams.getAll('or')).toEqual([
      '(and(or(currency.is.null,currency.eq.SEK),or(merchant_name.ilike.*acmefakeeqtrue*,description.ilike.*acmefakeeqtrue*)))',
    ])
  })
})
