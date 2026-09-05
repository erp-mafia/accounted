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

  it('runs the aggregate sweep for a nameless SEK invoice: a Bankgirot row names nobody anyway', async () => {
    const { supabase, queries } = createRecordingSupabase([
      [{ id: 'tx-bg', date: '2026-07-31', amount: 88250, description: 'BGGIRERING 03447786', merchant_name: null, reference: null }],
      [{ id: 'inv-064', invoice_number: '064', remaining_amount: 25750, total: 25750, due_date: '2026-07-31' }],
    ])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: { ...sekInvoice, invoice_number: '063', customer_name: null, total: 62500, total_sek: 62500 },
      paymentAmount: 62500,
      paymentDate: '2026-07-31',
    })
    // No name sweeps at all: straight to the two aggregate queries.
    expect(queries).toHaveLength(2)
    expect(queries[0].gt).toContainEqual(['amount', 62500])
    expect(candidates.map((c) => c.match_reason)).toEqual(['aggregate_exact'])
  })

  it('skips the name sweeps when the invoice has no customer name; only the aggregate row sweep runs', async () => {
    const { supabase, queries } = createRecordingSupabase([[]])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: { ...sekInvoice, customer_name: null },
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })
    expect(candidates).toEqual([])
    // No ILIKE probe without a name; the aggregate row sweep found nothing and stopped.
    expect(queries).toHaveLength(1)
    expect(queries[0].ilike).toBeUndefined()
  })
})

describe('findDuplicatePaymentCandidatesForInvoice: Bankgirot aggregate rows', () => {
  const invoice063 = { ...sekInvoice, invoice_number: '063', customer_name: 'Twelve Football AB', total: 62500, total_sek: 62500 }

  function aggregateRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'tx-bg',
      date: '2026-07-31',
      amount: 88250,
      description: 'BGGIRERING 03447786',
      merchant_name: null,
      reference: null,
      ...over,
    }
  }

  it('offers the aggregate row whose excess is exactly another open invoice', async () => {
    // Name sweeps find nothing ("BGGIRERING" carries no payer), then the
    // aggregate sweep: 88 250 - 62 500 = 25 750 = invoice 064's remaining.
    const { supabase, queries } = createRecordingSupabase([
      [],
      [],
      [aggregateRow()],
      [
        { id: 'inv-064', invoice_number: '064', remaining_amount: 25750, total: 25750, due_date: '2026-07-31' },
        { id: 'inv-065', invoice_number: '065', remaining_amount: 25750, total: 25750, due_date: '2026-09-30' },
        { id: 'inv-070', invoice_number: '070', remaining_amount: 999, total: 999, due_date: '2026-08-15' },
      ],
    ])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: invoice063,
      paymentAmount: 62500,
      paymentDate: '2026-07-31',
    })

    expect(queries).toHaveLength(4)
    // Rows larger than the payment, unbooked, kronor, on the payment day ± 7.
    expect(queries[2].gt).toContainEqual(['amount', 62500])
    expect(queries[2].is).toContainEqual(['journal_entry_id', null])
    expect(queries[2].or).toEqual([['currency.is.null,currency.eq.SEK']])
    expect(queries[2].gte).toContainEqual(['date', '2026-07-24'])
    expect(queries[2].lte).toContainEqual(['date', '2026-08-07'])
    // Other open invoices only: this one is excluded by number.
    expect(queries[3].neq).toContainEqual(['invoice_number', '063'])
    expect(queries[3].in).toContainEqual(['status', ['sent', 'overdue', 'partially_paid']])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: 'tx-bg',
      amount: 88250,
      match_reason: 'aggregate_exact',
      match_confidence: 0.9,
    })
    // The invoice due on the row's date wins over the identical one due later.
    expect(candidates[0].aggregate_invoice_numbers).toEqual(['064'])
  })

  it('does not run the aggregate sweep when a 1:1 candidate already exists', async () => {
    const { supabase, queries } = createRecordingSupabase([[bankRow()], []])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: sekInvoice,
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })
    expect(queries).toHaveLength(2)
    expect(candidates[0].match_reason).not.toBe('aggregate_exact')
  })

  it('stays silent when the excess is not an exact sum of other open invoices', async () => {
    const { supabase } = createRecordingSupabase([
      [],
      [],
      [aggregateRow()],
      [{ id: 'inv-x', invoice_number: '099', remaining_amount: 25000, total: 25000, due_date: '2026-07-31' }],
    ])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: invoice063,
      paymentAmount: 62500,
      paymentDate: '2026-07-31',
    })
    expect(candidates).toEqual([])
  })

  it('stops after the row sweep when no larger unbooked row exists', async () => {
    const { supabase, queries } = createRecordingSupabase([[], [], []])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: invoice063,
      paymentAmount: 62500,
      paymentDate: '2026-07-31',
    })
    expect(queries).toHaveLength(3)
    expect(candidates).toEqual([])
  })

  it('never runs for a foreign-currency invoice', async () => {
    const { supabase, queries } = createRecordingSupabase([[], [], [], []])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceWithRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })
    // The four name sweeps (two currencies x two patterns) and nothing more.
    expect(queries).toHaveLength(4)
    expect(candidates).toEqual([])
  })
})
