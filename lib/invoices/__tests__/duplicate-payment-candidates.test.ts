import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  findDuplicatePaymentCandidatesForInvoice,
  findDuplicatePaymentCandidatesForSupplierInvoice,
} from '@/lib/invoices/duplicate-payment-candidates'

type QueryRecord = Record<string, unknown[][]>

/**
 * Chainable Supabase stub that RECORDS the filter arguments of each query and
 * serves one queued page per `.from()` call, in call order. The shared
 * `createQueuedMockSupabase` helper drops filter arguments, and the whole point
 * here is which band was applied to which currency, and which needle probed
 * which columns.
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

const SEK_ROWS = 'currency.is.null,currency.eq.SEK'
const nameFilter = (needle: string) =>
  `merchant_name.ilike.%${needle}%,description.ilike.%${needle}%`

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
    journal_entry_id: null,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    ...over,
  }
}

/**
 * `lib/logger` deliberately suppresses non-error console output when
 * NODE_ENV === 'test', so a warn is unobservable unless the level policy is
 * lifted for the duration of the assertion.
 */
function captureWarnings() {
  vi.stubEnv('NODE_ENV', 'development')
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('findDuplicatePaymentCandidatesForInvoice', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('SEK invoice: ONE kronor-banded query probing merchant_name OR description on the first token', async () => {
    const { supabase, queries } = createRecordingSupabase([[bankRow()]])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: sekInvoice,
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })

    // The merchant_name and description probes used to be two queries with the
    // full name as needle; now one query, one alnum needle, both columns.
    expect(queries).toHaveLength(1)
    expect(queries[0].gte).toContainEqual(['amount', 12250])
    expect(queries[0].lte).toContainEqual(['amount', 12750])
    expect(queries[0].gt).toContainEqual(['amount', 0])
    // Band is kronor, so the rows it is applied to must be kronor.
    expect(queries[0].or).toContainEqual([SEK_ROWS])
    expect(queries[0].or).toContainEqual([nameFilter('acme')])
    expect(queries[0].ilike).toBeUndefined()
    expect(queries[0].select?.[0][0]).toContain('currency')
    expect(queries[0].select?.[0][0]).toContain('amount_sek')
    expect(queries[0].select?.[0][0]).toContain('exchange_rate')
    expect(queries[0].select?.[0][0]).toContain('journal_entry_id')

    expect(candidates).toHaveLength(1)
    expect(candidates[0].id).toBe('tx-1')
    expect(candidates[0].match_reason).toBe('name_amount_fuzzy')
    expect(candidates[0].journal_entry_id).toBeNull()
  })

  it('abbreviated bank text: "HI3G" in the description, merchant_name empty, IS a candidate (issue #2299)', async () => {
    const { supabase, queries } = createRecordingSupabase([
      [bankRow({ id: 'tx-hi3g', description: 'HI3G', merchant_name: null })],
    ])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: { ...sekInvoice, customer_name: 'Hi3G Access AB' },
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })

    expect(queries[0].or).toContainEqual([nameFilter('hi3g')])
    expect(candidates.map((c) => [c.id, c.match_reason])).toEqual([['tx-hi3g', 'name_amount_fuzzy']])
  })

  it('a row that is already a verifikat comes back as already_booked, ranked first, with its journal_entry_id', async () => {
    const { supabase } = createRecordingSupabase([
      [
        bankRow({ id: 'tx-unlinked', date: '2026-05-11' }),
        bankRow({ id: 'tx-booked', date: '2026-05-10', journal_entry_id: 'je-61' }),
      ],
    ])

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: sekInvoice,
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })

    expect(candidates.map((c) => [c.id, c.match_reason, c.journal_entry_id])).toEqual([
      ['tx-booked', 'already_booked', 'je-61'],
      ['tx-unlinked', 'name_amount_fuzzy', null],
    ])
  })

  it('EUR invoice with a rate: bands EUR rows in EUR and kronor rows in kronor', async () => {
    const { supabase, queries } = createRecordingSupabase([[], []])

    await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceWithRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })

    // One query per currency sweep (EUR, SEK).
    expect(queries).toHaveLength(2)
    expect(queries[0].or).toContainEqual(['currency.eq.EUR'])
    expect(queries[0].gte).toContainEqual(['amount', 980])
    expect(queries[0].lte).toContainEqual(['amount', 1020])
    expect(queries[1].or).toContainEqual([SEK_ROWS])
    expect(queries[1].gte).toContainEqual(['amount', 11270])
    expect(queries[1].lte).toContainEqual(['amount', 11730])
  })

  it('EUR invoice: a 1 000 SEK bank row is NOT offered as the payment for 1 000 EUR', async () => {
    // Page 0 is the EUR sweep; a kronor row of the same raw magnitude is what
    // the old EUR-band-on-a-kronor-column query surfaced.
    const { supabase } = createRecordingSupabase([
      [bankRow({ id: 'tx-sek-1000', amount: 1000, currency: 'SEK' })],
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
      [bankRow({ id: 'tx-sek-11500', amount: 11500, currency: 'SEK' })],
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
    ])
    // An unevaluated candidate set is not a clean "no duplicate": the blind
    // spot must be visible in behandlingshistorik (BFNAR 2013:2 p. 9.16).
    const warn = captureWarnings()

    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceNoRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })

    // No SEK sweep can be planned without a rate: only the EUR sweep runs.
    expect(queries).toHaveLength(1)
    expect(queries[0].or).toContainEqual(['currency.eq.EUR'])
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
    // No name sweep at all: straight to the two aggregate queries.
    expect(queries).toHaveLength(2)
    expect(queries[0].gt).toContainEqual(['amount', 62500])
    expect(candidates.map((c) => c.match_reason)).toEqual(['aggregate_exact'])
  })

  it('skips the name sweep when the invoice has no customer name; only the aggregate row sweep runs', async () => {
    const { supabase, queries } = createRecordingSupabase([[]])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: { ...sekInvoice, customer_name: null },
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })
    expect(candidates).toEqual([])
    // No name probe without a name; the aggregate row sweep found nothing and stopped.
    expect(queries).toHaveLength(1)
    expect(queries[0].or).not.toContainEqual([expect.stringContaining('ilike')])
  })

  it('treats a name with no usable token ("AB") like no name: aggregate sweep only', async () => {
    const { supabase, queries } = createRecordingSupabase([[]])
    await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: { ...sekInvoice, customer_name: 'AB' },
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })
    expect(queries).toHaveLength(1)
    expect(queries[0].or).not.toContainEqual([expect.stringContaining('ilike')])
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
    // The name sweep finds nothing ("BGGIRERING" carries no payer), then the
    // aggregate sweep: 88 250 - 62 500 = 25 750 = invoice 064's remaining.
    const { supabase, queries } = createRecordingSupabase([
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

    expect(queries).toHaveLength(3)
    // Rows larger than the payment, unbooked, kronor, on the payment day ± 7.
    expect(queries[1].gt).toContainEqual(['amount', 62500])
    expect(queries[1].is).toContainEqual(['journal_entry_id', null])
    expect(queries[1].or).toEqual([[SEK_ROWS]])
    expect(queries[1].gte).toContainEqual(['date', '2026-07-24'])
    expect(queries[1].lte).toContainEqual(['date', '2026-08-07'])
    // Other open invoices only: this one is excluded by number.
    expect(queries[2].neq).toContainEqual(['invoice_number', '063'])
    expect(queries[2].in).toContainEqual(['status', ['sent', 'overdue', 'partially_paid']])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: 'tx-bg',
      amount: 88250,
      match_reason: 'aggregate_exact',
      match_confidence: 0.9,
      journal_entry_id: null,
    })
    // The invoice due on the row's date wins over the identical one due later.
    expect(candidates[0].aggregate_invoice_numbers).toEqual(['064'])
  })

  it('does not run the aggregate sweep when a 1:1 candidate already exists', async () => {
    const { supabase, queries } = createRecordingSupabase([[bankRow()]])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: sekInvoice,
      paymentAmount: 12500,
      paymentDate: '2026-05-10',
    })
    expect(queries).toHaveLength(1)
    expect(candidates[0].match_reason).not.toBe('aggregate_exact')
  })

  it('stays silent when the excess is not an exact sum of other open invoices', async () => {
    const { supabase } = createRecordingSupabase([
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
    const { supabase, queries } = createRecordingSupabase([[], []])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: invoice063,
      paymentAmount: 62500,
      paymentDate: '2026-07-31',
    })
    expect(queries).toHaveLength(2)
    expect(candidates).toEqual([])
  })

  it('never runs for a foreign-currency invoice', async () => {
    const { supabase, queries } = createRecordingSupabase([[], []])
    const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
      companyId: 'company-1',
      invoice: eurInvoiceWithRate,
      paymentAmount: 1000,
      paymentDate: '2026-05-10',
    })
    // The two name sweeps (one per currency) and nothing more.
    expect(queries).toHaveLength(2)
    expect(candidates).toEqual([])
  })
})

describe('findDuplicatePaymentCandidatesForSupplierInvoice', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const hi3gInvoice = {
    supplier_invoice_number: '4471023987',
    payment_reference: null as string | null,
    supplier_name: 'Hi3G Access AB' as string | null | undefined,
    currency: 'SEK' as string | null,
    total: 12500 as number | null,
    total_sek: 12500 as number | null,
    exchange_rate: null as number | null,
  }

  function outboundRow(over: Partial<Record<string, unknown>> = {}) {
    return bankRow({ id: 'tx-out', amount: -12500, description: 'HI3G', merchant_name: null, ...over })
  }

  const run = (supabase: SupabaseClient, invoice = hi3gInvoice) =>
    findDuplicatePaymentCandidatesForSupplierInvoice(supabase, {
      companyId: 'company-1',
      invoice,
      paymentAmount: 12500,
      paymentDate: '2026-09-01',
    })

  it('the 2026-09-04 case: "HI3G" in the description, merchant_name empty, is flagged', async () => {
    const { supabase, queries } = createRecordingSupabase([[outboundRow()]])

    const candidates = await run(supabase)

    // Outbound, unlinked business rows, kronor-banded around -12 500 ± 2 %,
    // probed on the first distinctive token of the supplier name.
    expect(queries).toHaveLength(1)
    const q = queries[0]
    expect(q.lt).toContainEqual(['amount', 0])
    expect(q.gte).toContainEqual(['amount', -12750])
    expect(q.lte).toContainEqual(['amount', -12250])
    expect(q.gte).toContainEqual(['date', '2026-07-03'])
    expect(q.lte).toContainEqual(['date', '2026-10-31'])
    expect(q.is).toContainEqual(['supplier_invoice_id', null])
    expect(q.is).toContainEqual(['invoice_id', null])
    expect(q.eq).toContainEqual(['is_business', true])
    expect(q.or).toContainEqual([SEK_ROWS])
    expect(q.or).toContainEqual([nameFilter('hi3g')])
    expect(q.ilike).toBeUndefined()

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: 'tx-out',
      amount: -12500,
      match_reason: 'name_amount_fuzzy',
      journal_entry_id: null,
    })
  })

  it('a merchant_name hit scores the same as a description hit', async () => {
    const { supabase } = createRecordingSupabase([
      [outboundRow({ description: 'Kortköp', merchant_name: 'HI3G ACCESS' })],
    ])
    const candidates = await run(supabase)
    expect(candidates.map((c) => c.match_reason)).toEqual(['name_amount_fuzzy'])
  })

  it('no hit: an empty sweep yields no candidates and no second query (no aggregate sweep on the supplier side)', async () => {
    const { supabase, queries } = createRecordingSupabase([[]])
    expect(await run(supabase)).toEqual([])
    expect(queries).toHaveLength(1)
  })

  it('amount mismatch: a row the stub returns outside the band is dropped by the per-row re-check', async () => {
    const { supabase } = createRecordingSupabase([[outboundRow({ amount: -9000 })]])
    expect(await run(supabase)).toEqual([])
  })

  it('a row booked straight as an expense from the bank side is already_booked, with its verifikat, ranked first', async () => {
    // A61 in the case: the July bill booked from the bank row (Dr 6212 / Cr
    // 1930), then the invoice registered AND marked paid on top of it.
    const { supabase } = createRecordingSupabase([
      [
        outboundRow({ id: 'tx-unlinked', date: '2026-09-02' }),
        outboundRow({ id: 'tx-a61', date: '2026-08-28', journal_entry_id: 'je-a61' }),
      ],
    ])
    const candidates = await run(supabase)
    expect(candidates.map((c) => [c.id, c.match_reason, c.journal_entry_id])).toEqual([
      ['tx-a61', 'already_booked', 'je-a61'],
      ['tx-unlinked', 'name_amount_fuzzy', null],
    ])
    expect(candidates[0].match_confidence).toBe(0.85)
  })

  it('the payment reference typed into the bank transfer is an exact OCR match', async () => {
    const { supabase } = createRecordingSupabase([
      [outboundRow({ description: 'Betalning', reference: '1234 5678 90' })],
    ])
    const candidates = await run(supabase, { ...hi3gInvoice, payment_reference: '1234567890' })
    expect(candidates.map((c) => c.match_reason)).toEqual(['ocr_exact'])
  })

  it('a short supplier invoice number is not an OCR: "7" does not turn every reference with a 7 into an exact match', async () => {
    const { supabase } = createRecordingSupabase([
      [outboundRow({ description: 'HI3G', reference: '7' })],
    ])
    const candidates = await run(supabase, { ...hi3gInvoice, supplier_invoice_number: '7' })
    expect(candidates.map((c) => c.match_reason)).toEqual(['name_amount_fuzzy'])
  })

  it('missing supplier name: no query, empty result, and the skipped guard is logged', async () => {
    const { supabase, queries } = createRecordingSupabase([])
    const warn = captureWarnings()
    expect(await run(supabase, { ...hi3gInvoice, supplier_name: null })).toEqual([])
    expect(queries).toHaveLength(0)
    expect(JSON.stringify(warn.mock.calls)).toContain('missing_supplier_name')
  })

  it('a name with no usable token ("AB") skips the sweep the same way', async () => {
    const { supabase, queries } = createRecordingSupabase([])
    const warn = captureWarnings()
    expect(await run(supabase, { ...hi3gInvoice, supplier_name: 'AB' })).toEqual([])
    expect(queries).toHaveLength(0)
    expect(JSON.stringify(warn.mock.calls)).toContain('unusable_supplier_name')
  })

  it('EUR invoice with a rate: EUR rows banded in EUR, kronor rows in kronor, both outbound', async () => {
    const { supabase, queries } = createRecordingSupabase([[], [outboundRow({ amount: -11500 })]])
    const candidates = await findDuplicatePaymentCandidatesForSupplierInvoice(supabase, {
      companyId: 'company-1',
      invoice: { ...hi3gInvoice, currency: 'EUR', total: 1000, total_sek: 11500, exchange_rate: 11.5 },
      paymentAmount: 1000,
      paymentDate: '2026-09-01',
    })
    expect(queries).toHaveLength(2)
    expect(queries[0].or).toContainEqual(['currency.eq.EUR'])
    expect(queries[0].gte).toContainEqual(['amount', -1020])
    expect(queries[0].lte).toContainEqual(['amount', -980])
    expect(queries[1].or).toContainEqual([SEK_ROWS])
    expect(queries[1].gte).toContainEqual(['amount', -11730])
    expect(queries[1].lte).toContainEqual(['amount', -11270])
    expect(candidates.map((c) => c.id)).toEqual(['tx-out'])
  })
})
