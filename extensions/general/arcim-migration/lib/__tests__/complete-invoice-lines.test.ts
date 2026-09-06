import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SalesInvoiceDto } from '@/lib/providers/dto'

/**
 * The follow-up pass for migrated sales invoices imported without rows
 * (Fortnox, Briox and Björn Lundén ship none in a list payload, and the
 * migration's detail hydration is budget-bounded). It must start from OUR
 * row-less invoices, join strictly, hydrate only that subset, write rows only
 * when the provider's total agrees with the stored one, and leave anything it
 * could not reach for the next run rather than guessing. Every write goes
 * through the complete_invoice_rows RPC, one call per invoice, which is what
 * keeps two writers from doubling an invoice's rows.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'fortnox' },
    accessToken: 'tok',
    providerCompanyId: undefined,
  }),
}))

vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchSalesInvoicesDirect: vi.fn(),
  hydrateSalesInvoices: vi.fn(),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: vi.fn() }))

import { resolveConsent } from '@/lib/providers/resolve-consent'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchSalesInvoicesDirect, hydrateSalesInvoices } from '@/lib/providers/provider-data-fetcher'
import { completeMigratedInvoiceLines } from '../complete-invoice-lines'

const mResolve = resolveConsent as Mock
const mFetchAll = fetchAllRows as Mock
const mList = fetchSalesInvoicesDirect as Mock
const mHydrate = hydrateSalesInvoices as Mock

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }

const amount = (value: number, currencyCode = 'SEK') => ({ value, currencyCode })

/** A hydrated Fortnox-shaped invoice: 1 000 kr net, 25 % VAT, 1 250 kr total. */
function providerInvoice(overrides: Partial<SalesInvoiceDto> = {}): SalesInvoiceDto {
  return {
    id: '1001',
    invoiceNumber: '1001',
    issueDate: '2026-03-14',
    currencyCode: 'SEK',
    status: 'paid',
    supplier: { name: 'Profilio Sweden AB', identifications: [] },
    customer: { name: 'Kund AB', identifications: [] },
    lines: [
      {
        id: '1',
        description: 'Konsulttid',
        quantity: 10,
        unitCode: 'h',
        unitPrice: amount(100),
        lineExtensionAmount: amount(1000),
        taxPercent: 25,
      },
    ],
    taxTotal: { taxAmount: amount(250) },
    legalMonetaryTotal: {
      lineExtensionAmount: amount(1000),
      taxInclusiveAmount: amount(1250),
      payableAmount: amount(1250),
    },
    paymentStatus: { paid: true, balance: amount(0) },
    ...overrides,
  }
}

/** A stored row as the pre-#1745 import left it: 25 % label, 0 kr VAT, no rows. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2026-03-14',
    total: 1250,
    subtotal: 1250,
    vat_amount: 0,
    vat_rate: 25,
    currency: 'SEK',
    exchange_rate: null,
    invoice_items: [],
    ...overrides,
  }
}

/** Every hydrated as given, in order, nothing left unhydrated. */
function hydratedAll(invoices: SalesInvoiceDto[], unhydratedIds: string[] = []) {
  return {
    invoices,
    hydration: { ...HYDRATION, needed: invoices.length, hydrated: invoices.length - unhydratedIds.length },
    unhydratedIds: new Set(unhydratedIds),
  }
}

interface Call { table: string; method: string; args: unknown[] }

/** The complete_invoice_rows payload, as the pass sends it. */
interface RpcArgs {
  p_company_id: string
  p_invoice_id: string
  p_rows: Record<string, unknown>[]
  p_header: Record<string, unknown> | null
}

/** What the real RPC answers a caller that wrote: N rows, header iff one was sent. */
function rpcWrote(args: RpcArgs) {
  return {
    data: { ok: true, wrote: true, rows: args.p_rows.length, header_updated: args.p_header !== null },
    error: null,
  }
}

const rpcAlreadyFilled = { data: { ok: true, wrote: false, rows: 0, header_updated: false }, error: null }

/**
 * Query-builder and RPC stand-in. Records every call; `respond` answers the
 * table chains, `respondRpc` answers `.rpc()` (defaults to a successful
 * write shaped like the real function's reply).
 */
function makeSupabase(
  respond: (table: string, methods: string[], calls: Call[]) => unknown,
  respondRpc: (fn: string, args: RpcArgs) => unknown = (_fn, args) => rpcWrote(args),
) {
  const calls: Call[] = []
  const from = vi.fn((table: string) => {
    const chain: Call[] = []
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'in', 'insert', 'update', 'eq', 'neq', 'order', 'range']) {
      builder[method] = (...args: unknown[]) => {
        const call = { table, method, args }
        chain.push(call)
        calls.push(call)
        return builder
      }
    }
    builder.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve()
        .then(() => respond(table, chain.map((c) => c.method), chain))
        .then(resolve, reject)
    return builder
  })
  const rpc = vi.fn((fn: string, args: RpcArgs) => {
    calls.push({ table: `rpc:${fn}`, method: 'rpc', args: [fn, args] })
    return Promise.resolve(respondRpc(fn, args))
  })
  return { supabase: { from, rpc } as unknown as SupabaseClient, calls }
}

const ok = { data: [], error: null }

function writes(calls: Call[]): RpcArgs[] {
  return calls
    .filter((c) => c.method === 'rpc' && c.args[0] === 'complete_invoice_rows')
    .map((c) => c.args[1] as RpcArgs)
}

/** The rows sent, each tagged with the invoice the call named. */
function insertedRows(calls: Call[]): Record<string, unknown>[] {
  return writes(calls).flatMap((w) => w.p_rows.map((row) => ({ ...row, invoice_id: w.p_invoice_id })))
}

function headerUpdates(calls: Call[]): Record<string, unknown>[] {
  return writes(calls)
    .map((w) => w.p_header)
    .filter((h): h is Record<string, unknown> => h !== null)
}

describe('completeMigratedInvoiceLines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mResolve.mockResolvedValue({ consent: { provider: 'fortnox' }, accessToken: 'tok', providerCompanyId: undefined })
  })

  it('writes the rows and fills a header that held no VAT evidence, through one RPC call per invoice', async () => {
    mFetchAll.mockResolvedValue([storedRow()])
    const dto = providerInvoice()
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({
      candidates: 1, providerInvoices: 1, matched: 1, unmatched: 0,
      completed: 1, headersUpdated: 1, remaining: 0, totalMismatch: 0, notHydrated: 0, failed: 0,
    })
    // Only the matched subset is hydrated, so the budget is never spent on
    // invoices already complete on our side.
    expect(mHydrate).toHaveBeenCalledTimes(1)
    expect(mHydrate.mock.calls[0][3]).toEqual([dto])

    // One call, scoped to the company as well as the invoice: the RPC locks
    // the invoice and stamps invoice_id itself, so the rows carry none.
    const sent = writes(calls)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ p_company_id: 'co-1', p_invoice_id: 'inv-1' })
    expect(sent[0].p_rows).toHaveLength(1)
    expect(sent[0].p_rows[0]).not.toHaveProperty('invoice_id')
    expect(sent[0].p_rows[0]).toEqual({
      sort_order: 1,
      description: 'Konsulttid',
      quantity: 10,
      unit: 'h',
      unit_price: 100,
      line_total: 1000,
      vat_rate: 25,
      vat_amount: 250,
      line_type: 'product',
    })
    expect(sent[0].p_header).toEqual({
      subtotal: 1000,
      subtotal_sek: 1000,
      vat_amount: 250,
      vat_amount_sek: 250,
      vat_rate: 25,
      vat_treatment: 'standard_25',
    })
    // Never the total, status or payments.
    expect(Object.keys(sent[0].p_header!)).not.toContain('total')
    expect(Object.keys(sent[0].p_header!)).not.toContain('status')
    // Nothing is written outside the RPC.
    expect(calls.filter((c) => c.method !== 'rpc')).toHaveLength(0)
  })

  it('writes the rows but leaves a header whose split is consistent (momsfri)', async () => {
    mFetchAll.mockResolvedValue([storedRow({ vat_rate: 0, vat_amount: 0, subtotal: 1250 })])
    const dto = providerInvoice()
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ completed: 1, headersUpdated: 0 })
    expect(insertedRows(calls)).toHaveLength(1)
    expect(writes(calls)[0].p_header).toBeNull()
    expect(headerUpdates(calls)).toHaveLength(0)
  })

  it('fills a header whose rate is null (the post-#1745 "source did not say")', async () => {
    mFetchAll.mockResolvedValue([storedRow({ vat_rate: null, vat_amount: 0, subtotal: 1250 })])
    const dto = providerInvoice()
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ completed: 1, headersUpdated: 1 })
    expect(headerUpdates(calls)[0]).toMatchObject({ vat_rate: 25, vat_amount: 250, subtotal: 1000 })
  })

  it('derives the SEK twins from the rate the row already carries', async () => {
    mFetchAll.mockResolvedValue([storedRow({ currency: 'EUR', exchange_rate: 11.2, total: 1250 })])
    const dto = providerInvoice({ currencyCode: 'EUR' })
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(headerUpdates(calls)[0]).toMatchObject({ subtotal: 1000, subtotal_sek: 11200, vat_amount: 250, vat_amount_sek: 2800 })
  })

  it('refuses rows that do not add up to the header the same payload established', async () => {
    // The shape Profilio's 345 invoices took: rows priced with VAT inside,
    // summing to the gross, beside a header that was right. Storing them
    // would put a row list under the invoice that contradicts its totals.
    mFetchAll.mockResolvedValue([storedRow()])
    const dto = providerInvoice({
      lines: [
        { id: '1', description: 'Mugg', quantity: 1, unitPrice: amount(1250), lineExtensionAmount: amount(1250), taxPercent: 25 },
      ],
    })
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ matched: 1, completed: 0, rowsMismatch: 1, remaining: 1 })
    expect(writes(calls)).toHaveLength(0)
  })

  it('tolerates öresavrundning between the rows and the header', async () => {
    // Fortnox rounds Total to whole kronor; the header net absorbs the öre.
    mFetchAll.mockResolvedValue([storedRow({ total: 12263 })])
    const dto = providerInvoice({
      lines: [{ id: '1', description: 'Konsult', quantity: 1, unitPrice: amount(9810), lineExtensionAmount: amount(9810), taxPercent: 25 }],
      taxTotal: { taxAmount: amount(2452.5) },
      legalMonetaryTotal: { lineExtensionAmount: amount(9810.5), taxInclusiveAmount: amount(12263), payableAmount: amount(12263) },
    })
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ completed: 1, rowsMismatch: 0 })
    expect(insertedRows(calls)).toHaveLength(1)
  })

  it('leaves an invoice untouched when the provider total differs from the stored one', async () => {
    mFetchAll.mockResolvedValue([storedRow({ total: 1300, subtotal: 1300 })])
    const dto = providerInvoice()
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ matched: 1, completed: 0, totalMismatch: 1, remaining: 1 })
    expect(writes(calls)).toHaveLength(0)
  })

  it('reverses the rows of a kreditfaktura the way the migration does', async () => {
    mFetchAll.mockResolvedValue([storedRow({ total: -1250, subtotal: -1250 })])
    const dto = providerInvoice({ invoiceTypeCode: '381', status: 'credited' })
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ completed: 1, totalMismatch: 0 })
    expect(insertedRows(calls)[0]).toMatchObject({ quantity: -10, unit_price: 100, line_total: -1000, vat_amount: -250 })
    expect(headerUpdates(calls)[0]).toMatchObject({ subtotal: -1000, vat_amount: -250 })
  })

  it('leaves invoices the budget did not reach for the next run', async () => {
    mFetchAll.mockResolvedValue([storedRow(), storedRow({ id: 'inv-2', invoice_number: '1002' })])
    const first = providerInvoice()
    const second = providerInvoice({ id: '1002', invoiceNumber: '1002', lines: [] })
    mList.mockResolvedValue([first, second])
    // The second came back in list form only (no rows): the budget ran out.
    mHydrate.mockResolvedValue(hydratedAll([first, second], ['1002']))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ candidates: 2, matched: 2, completed: 1, notHydrated: 1, remaining: 1 })
    expect(writes(calls).map((w) => w.p_invoice_id)).toEqual(['inv-1'])
  })

  it('does not join an ambiguous key, and does not hydrate when nothing joined', async () => {
    // Two stored rows with the same number and date: a wrong join would put
    // one invoice's rows under the other.
    mFetchAll.mockResolvedValue([storedRow(), storedRow({ id: 'inv-dup' })])
    mList.mockResolvedValue([providerInvoice()])
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ candidates: 2, matched: 0, unmatched: 2, completed: 0, remaining: 2 })
    expect(mHydrate).not.toHaveBeenCalled()
    expect(writes(calls)).toHaveLength(0)
  })

  it('costs one query and no provider call when the company has nothing to complete', async () => {
    mFetchAll.mockResolvedValue([storedRow({ invoice_items: [{ id: 'item-1' }] })])
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ candidates: 0, completed: 0, remaining: 0 })
    expect(mResolve).not.toHaveBeenCalled()
    expect(mList).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('counts an invoice that gained rows since the candidates were loaded as skipped, not completed', async () => {
    // The RPC answers wrote = false: another writer (the wizard, an
    // overlapping cron) got there first. The header in the payload must not
    // be counted either; header_updated comes from the RPC, not the plan.
    mFetchAll.mockResolvedValue([storedRow()])
    const dto = providerInvoice()
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok, () => rpcAlreadyFilled)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ completed: 0, headersUpdated: 0, failed: 0, remaining: 1 })
    expect(writes(calls)).toHaveLength(1)
    expect(writes(calls)[0].p_header).not.toBeNull()
  })

  it('counts a refused or failed call as failed and goes on with the rest', async () => {
    mFetchAll.mockResolvedValue([
      storedRow(),
      storedRow({ id: 'inv-2', invoice_number: '1002' }),
      storedRow({ id: 'inv-3', invoice_number: '1003' }),
    ])
    const dtos = [
      providerInvoice(),
      providerInvoice({ id: '1002', invoiceNumber: '1002' }),
      providerInvoice({ id: '1003', invoiceNumber: '1003' }),
    ]
    mList.mockResolvedValue(dtos)
    mHydrate.mockResolvedValue(hydratedAll(dtos))
    const { supabase, calls } = makeSupabase(() => ok, (_fn, args) => {
      // A Postgres error (a check violation inside the RPC) and a refusal
      // the function answers with ok = false: both leave the invoice for a
      // human to look at, neither stops the run.
      if (args.p_invoice_id === 'inv-2') return { data: null, error: { message: 'check violation' } }
      if (args.p_invoice_id === 'inv-3') return { data: { ok: false, code: 'INVOICE_NOT_FOUND' }, error: null }
      return rpcWrote(args)
    })

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1' })

    expect(result).toMatchObject({ completed: 1, failed: 2, headersUpdated: 1, remaining: 2 })
    expect(writes(calls).map((w) => w.p_invoice_id)).toEqual(['inv-1', 'inv-2', 'inv-3'])
  })

  it('dry run: reports the plan and writes nothing', async () => {
    mFetchAll.mockResolvedValue([storedRow()])
    const dto = providerInvoice()
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase, calls } = makeSupabase(() => ok)

    const result = await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1', dryRun: true })

    expect(result).toMatchObject({ dryRun: true, completed: 1, headersUpdated: 1, remaining: 0 })
    expect(calls).toHaveLength(0)
  })

  it('passes the budget through to the hydration', async () => {
    mFetchAll.mockResolvedValue([storedRow()])
    const dto = providerInvoice()
    mList.mockResolvedValue([dto])
    mHydrate.mockResolvedValue(hydratedAll([dto]))
    const { supabase } = makeSupabase(() => ok)

    await completeMigratedInvoiceLines({ supabase, companyId: 'co-1', consentId: 'c-1', budgetMs: 45_000 })

    expect(mHydrate.mock.calls[0][4]).toBe(45_000)
  })
})
