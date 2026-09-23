/**
 * The duplicate-payment guard's plus-minus 2 % band and the column it is
 * applied to must share a unit.
 *
 * `paymentAmount` (from `supplier_invoices.remaining_amount` or `body.amount`)
 * is denominated in the INVOICE's currency; `transactions.amount` is
 * denominated in the BANK ROW's currency. At roughly 11,50 SEK/EUR a band built
 * around a EUR figure and applied to a kronor column is off by a factor of
 * eleven: it selects nothing (a second verifikat for one affärshändelse then
 * posts unopposed, BFL 5 kap 1-2 §) or it selects an unrelated row.
 *
 * These tests assert the FILTER VALUES the route actually sends. The shared
 * `createQueuedMockSupabase` helper drops filter arguments, so an assertion on
 * the response shape alone passes against the pre-fix band as long as the
 * queued page happens to be empty. The whole finding lives in the arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'

/** One recorded query: which table, and every filter argument it received. */
type RecordedQuery = { table: string; calls: Record<string, unknown[][]> }

/**
 * Chainable Supabase stub that RECORDS each query's filter arguments and serves
 * one queued page per table, in call order. Keying the pages by table (rather
 * than by a single global queue) keeps the assertions stable when an unrelated
 * lookup is added to the route.
 */
function createRecordingSupabase(pages: Record<string, Array<{ data?: unknown; error?: unknown }>>) {
  const queries: RecordedQuery[] = []
  const queues: Record<string, Array<{ data: unknown; error: unknown }>> = {}
  for (const [table, list] of Object.entries(pages)) {
    queues[table] = list.map((r) => ({ data: r.data ?? null, error: r.error ?? null }))
  }

  const from = (table: string) => {
    const result = queues[table]?.shift() ?? { data: null, error: null }
    const calls: Record<string, unknown[][]> = {}
    queries.push({ table, calls })
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          return (...args: unknown[]) => {
            ;(calls[prop] ??= []).push(args)
            return chain
          }
        },
      },
    )
    return chain
  }

  const supabase = {
    from: vi.fn(from),
    rpc: vi.fn(() => from('__rpc')),
    auth: { getUser: vi.fn() },
  }

  return { supabase, queries }
}

const recording = createRecordingSupabase({})
let mockSupabase = recording.supabase
let recorded: RecordedQuery[] = recording.queries

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase as unknown as SupabaseClient),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCreateSupplierInvoicePaymentEntry = vi.fn()
const mockCreateSupplierInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoicePaymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoiceCashEntry(...args),
}))

vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service',
  )
  return { ...actual, linkToJournalEntry: vi.fn() }
})

// Mocked away so the settled-suggestion cleanup (issue #1259) does not add a
// `transactions` query to the recorded set: the txQueries() assertions below
// are about the duplicate-guard sweeps only. The helper's own query shape is
// pinned by lib/invoices/__tests__/clear-settled-invoice-suggestions.test.ts.
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn().mockResolvedValue(undefined),
}))

import { eventBus } from '@/lib/events'
import { POST } from '../route'

/** Install a fresh recording client with the given per-table pages. */
function useSupabase(pages: Record<string, Array<{ data?: unknown; error?: unknown }>>) {
  const next = createRecordingSupabase(pages)
  mockSupabase = next.supabase
  recorded = next.queries
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  return next
}

const bankRow = (over: Record<string, unknown> = {}) => ({
  id: 'tx-99',
  date: '2026-05-10',
  amount: -12500,
  description: 'Betalning Leverantör AB',
  merchant_name: 'Leverantör AB',
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  ...over,
})

const markPaid = async () => {
  const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
    method: 'POST',
    body: {},
  })
  return POST(request, createMockRouteParams({ id: 'si-1' }))
}

const txQueries = () => recorded.filter((q) => q.table === 'transactions')

describe('POST /api/supplier-invoices/[id]/mark-paid: duplicate-guard band units', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('SEK invoice: one kronor-banded sweep with the same band, probing both name columns', async () => {
    useSupabase({
      supplier_invoices: [
        {
          data: makeSupplierInvoice({
            id: 'si-1',
            status: 'approved',
            currency: 'SEK',
            total: 12500,
            total_sek: 12500,
            exchange_rate: null,
            remaining_amount: 12500,
            paid_amount: 0,
            supplier: makeSupplier({ name: 'Leverantör AB' }),
            items: [],
          }),
        },
      ],
      transactions: [{ data: [bankRow()] }],
    })

    const response = await markPaid()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_PAID_LIKELY_DUPLICATE')

    // A SEK-only company must still see exactly one query with the old band.
    expect(txQueries()).toHaveLength(1)
    const q = txQueries()[0].calls
    expect(q.gte).toContainEqual(['amount', -12750])
    expect(q.lte).toContainEqual(['amount', -12250])
    // Band is kronor, so the rows it is applied to must be kronor. NULL is
    // kronor too: transactions.currency is nullable with DEFAULT 'SEK'.
    // Issue #2299: the needle is the first distinctive token of the supplier
    // name, probed on merchant_name OR description (the old guard sent
    // `%Leverantör AB%` against merchant_name only), and the currency clause
    // is nested into the SAME single .or() so nothing rides on how PostgREST
    // treats a repeated `or=` key.
    expect(q.or).toEqual([[
      'and(or(currency.is.null,currency.eq.SEK),or(merchant_name.ilike.*leverantör*,description.ilike.*leverantör*))',
    ]])
    expect(q.ilike).toBeUndefined()
    // The per-row re-check reads these columns; a narrow projection would make
    // it read `undefined` and silently default every row to SEK.
    expect(q.select?.[0][0]).toContain('currency')
    expect(q.select?.[0][0]).toContain('amount_sek')
    expect(q.select?.[0][0]).toContain('exchange_rate')
  })

  it('EUR invoice with a rate: EUR rows banded in EUR, kronor rows banded in kronor', async () => {
    useSupabase({
      supplier_invoices: [
        {
          data: makeSupplierInvoice({
            id: 'si-1',
            status: 'approved',
            currency: 'EUR',
            total: 1000,
            total_sek: 11500,
            exchange_rate: 11.5,
            remaining_amount: 1000,
            paid_amount: 0,
            supplier: makeSupplier({ name: 'Leverantör AB' }),
            items: [],
          }),
        },
      ],
      // EUR sweep finds nothing; the kronor sweep finds the row that actually
      // paid the invoice, at the converted magnitude.
      transactions: [{ data: [] }, { data: [bankRow({ amount: -11500 })] }],
    })

    const response = await markPaid()
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ id: string }> } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates.map((c) => c.id)).toEqual(['tx-99'])

    expect(txQueries()).toHaveLength(2)
    const eur = txQueries()[0].calls
    expect(eur.or).toEqual([[
      'and(or(currency.eq.EUR),or(merchant_name.ilike.*leverantör*,description.ilike.*leverantör*))',
    ]])
    expect(eur.gte).toContainEqual(['amount', -1020])
    expect(eur.lte).toContainEqual(['amount', -980])

    const sek = txQueries()[1].calls
    expect(sek.or).toEqual([[
      'and(or(currency.is.null,currency.eq.SEK),or(merchant_name.ilike.*leverantör*,description.ilike.*leverantör*))',
    ]])
    // 1 000 EUR x 11,50 = 11 500 kr, banded plus-minus 2 %. The pre-fix query
    // asked kronor rows for -1 020..-980 and matched nothing.
    expect(sek.gte).toContainEqual(['amount', -11730])
    expect(sek.lte).toContainEqual(['amount', -11270])
  })

  it('EUR invoice with no stored rate: no kronor sweep is invented', async () => {
    useSupabase({
      supplier_invoices: [
        {
          data: makeSupplierInvoice({
            id: 'si-1',
            status: 'approved',
            currency: 'EUR',
            total: 1000,
            total_sek: null,
            exchange_rate: null,
            remaining_amount: 1000,
            paid_amount: 0,
            supplier: makeSupplier({ name: 'Leverantör AB' }),
            items: [],
          }),
        },
        // The status flip after the guard lets the payment through.
        { data: [{ id: 'si-1' }] },
      ],
      // The single EUR sweep returns a kronor row anyway (PostgREST `.or()`
      // composes with the other filters and this stub ignores them): the
      // per-row re-check must drop it rather than read -1000 kr as -1000 EUR.
      transactions: [{ data: [bankRow({ amount: -1000, currency: 'SEK' })] }],
      company_settings: [{ data: { accounting_method: 'accrual' } }],
    })
    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })

    const response = await markPaid()
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(txQueries()).toHaveLength(1)
    expect(txQueries()[0].calls.or).toEqual([[
      'and(or(currency.eq.EUR),or(merchant_name.ilike.*leverantör*,description.ilike.*leverantör*))',
    ]])
  })
})
