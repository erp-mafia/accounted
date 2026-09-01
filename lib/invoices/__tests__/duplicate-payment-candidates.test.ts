import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'

type QueryRecord = Record<string, unknown[][]>

/**
 * Chainable Supabase stub that RECORDS the filter arguments of each query and
 * serves one queued page per `.from()` call, in call order. The shared
 * `createQueuedMockSupabase` helper drops filter arguments, and the whole point
 * here is which band was applied to which currency.
 */
function createRecordingSupabase(pages: Array<Array<Record<string, unknown>>>) {
  const queries: QueryRecord[] = []

  const build = () => {
    const index = queries.length
    const record: QueryRecord = {}
    queries.push(record)
    const result = { data: pages[index] ?? [], error: null }

    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          return (...args: unknown[]) => {
            ;(record[prop] ??= []).push(args)
            return chain
          }
        },
      },
    )
    return chain
  }

  const supabase = { from: () => build() } as unknown as SupabaseClient
  return { supabase, queries }
}

const sekInvoice = {
  invoice_number: '2026-0042',
  customer_name: 'Acme AB',
  currency: 'SEK' as string | null,
  total: 12500 as number | null,
  total_sek: 12500 as number | null,
  exchange_rate: null as number | null,
}

const eurInvoiceWithRate = {
  invoice_number: '2026-0043',
  customer_name: 'Acme AB',
  currency: 'EUR' as string | null,
  total: 1000 as number | null,
  total_sek: 11500 as number | null,
  exchange_rate: 11.5 as number | null,
}

const eurInvoiceNoRate = {
  ...eurInvoiceWithRate,
  total_sek: null,
  exchange_rate: null,
}

function bankRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tx-1',
    date: '2026-05-10',
    amount: 12500,
    description: 'Inbetalning Acme AB',
    merchant_name: 'Acme AB',
    reference: null,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    ...over,
  }
}

describe('findDuplicatePaymentCandidatesForInvoice', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  /**
   * `lib/logger` deliberately suppresses non-error console output when
   * NODE_ENV === 'test', so a warn is unobservable unless the level policy is
   * lifted for the duration of the assertion.
   */
  function captureWarnings() {
    vi.stubEnv('NODE_ENV', 'development')
    return vi.spyOn(console, 'warn').mockImplementation(() => {})
  }

  it('SEK invoice: one sweep per name pattern, band unchanged, kronor rows only', async () => {
    const { supabase, queries } = createRecordingSupabase([[bankRow()], []])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: sekInvoice,
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })

    // merchant_name sweep + description sweep: the same two queries as before.
    expect(queries).toHaveLength(2)
    expect(queries[0].gte).toContainEqual(['amount', 12250])
    expect(queries[0].lte).toContainEqual(['amount', 12750])
    // Band is kronor, so the rows it is applied to must be kronor.
    expect(queries[0].or).toEqual([['currency.is.null,currency.eq.SEK']])
    expect(queries[0].select?.[0][0]).toContain('currency')
    expect(queries[0].select?.[0][0]).toContain('amount_sek')
    expect(queries[0].select?.[0][0]).toContain('exchange_rate')

    expect(candidates).toHaveLength(1)
    expect(candidates[0].id).toBe('tx-1')
  })

  it('EUR invoice with a rate: bands EUR rows in EUR and kronor rows in kronor', async () => {
    const { supabase, queries } = createRecordingSupabase([[], [], [], []])

    await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceWithRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })

    // Two sweeps (EUR, SEK) x two name patterns.
    expect(queries).toHaveLength(4)
    expect(queries[0].or).toEqual([['currency.eq.EUR']])
    expect(queries[0].gte).toContainEqual(['amount', 980])
    expect(queries[0].lte).toContainEqual(['amount', 1020])
    expect(queries[2].or).toEqual([['currency.is.null,currency.eq.SEK']])
    expect(queries[2].gte).toContainEqual(['amount', 11270])
    expect(queries[2].lte).toContainEqual(['amount', 11730])
  })

  it('EUR invoice: a 1 000 SEK bank row is NOT offered as the payment for 1 000 EUR', async () => {
    // Page 0 is the EUR sweep; a kronor row of the same raw magnitude is what
    // the old EUR-band-on-a-kronor-column query surfaced.
    const { supabase } = createRecordingSupabase([
      [bankRow({ id: 'tx-sek-1000', amount: 1000, currency: 'SEK' })],
      [],
      [],
      [],
    ])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceWithRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })

    expect(candidates).toEqual([])
  })

  it('EUR invoice with a rate: the 11 500 SEK bank row that actually paid it IS offered', async () => {
    const { supabase } = createRecordingSupabase([
      [],
      [],
      [bankRow({ id: 'tx-sek-11500', amount: 11500, currency: 'SEK' })],
      [],
    ])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceWithRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })

    expect(candidates.map((c) => c.id)).toEqual(['tx-sek-11500'])
  })

  it('EUR invoice with a rate: a 1 000 EUR bank row still matches in its own currency', async () => {
    const { supabase } = createRecordingSupabase([
      [bankRow({ id: 'tx-eur-1000', amount: 1000, currency: 'EUR', amount_sek: 11500 })],
      [],
      [],
      [],
    ])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceWithRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })

    expect(candidates.map((c) => c.id)).toEqual(['tx-eur-1000'])
  })

  it('EUR invoice with no stored rate: kronor rows are excluded, not compared raw', async () => {
    const { supabase, queries } = createRecordingSupabase([
      [bankRow({ id: 'tx-sek-1000', amount: 1000, currency: 'SEK' })],
      [],
    ])
    // An unevaluated candidate set is not a clean "no duplicate": the blind
    // spot must be visible in behandlingshistorik (BFNAR 2013:2 p. 9.16), the
    // same way the supplier-side twin logs it.
    const warn = captureWarnings()

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceNoRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })

    // No SEK sweep can be planned without a rate: only the EUR sweep runs.
    expect(queries).toHaveLength(2)
    expect(queries[0].or).toEqual([['currency.eq.EUR']])
    expect(candidates).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).toContain('invoice_missing_sek_value')
  })

  it('SEK invoice: no cross-currency warning is logged', async () => {
    const { supabase } = createRecordingSupabase([[], []])
    const warn = captureWarnings()

    await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: sekInvoice,
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })

    expect(warn).not.toHaveBeenCalled()
  })

  it('returns nothing when the invoice has no customer name', async () => {
    const { supabase, queries } = createRecordingSupabase([])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: { ...sekInvoice, customer_name: null },
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })
    expect(candidates).toEqual([])
    expect(queries).toHaveLength(0)
  })
})
