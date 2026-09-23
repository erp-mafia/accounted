import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/bookkeeping/currency-utils', () => ({
  resolveSekAmount: vi.fn(
    (
      amount: number,
      _amountSek: number | null,
      currency: string | null,
      rate: number | null
    ) => (currency && currency !== 'SEK' && rate ? amount * rate : amount)
  ),
}))

import { GET } from '../route'

interface QueryResult {
  data: unknown
  error: unknown
}

/**
 * The invoices query is paginated via fetchAllRows (.range per page), so the
 * mock serves one page result per .range() call. A single QueryResult is a
 * one-page company; pass an array to exercise multi-page paging.
 */
function buildSupabase(
  supplier: { id: string; name: string } | null,
  invoicesResults: QueryResult | QueryResult[],
  entriesResult: QueryResult
) {
  const pages = Array.isArray(invoicesResults) ? [...invoicesResults] : [invoicesResults]
  const rangeCalls: Array<[number, number]> = []
  const orderCalls: unknown[][] = []
  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'suppliers') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: supplier, error: null }),
        }
      }
      if (table === 'supplier_invoices') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockImplementation(function (this: unknown, ...args: unknown[]) {
            orderCalls.push(args)
            return this
          }),
          range: vi.fn().mockImplementation((from: number, to: number) => {
            rangeCalls.push([from, to])
            return Promise.resolve(pages.shift() ?? { data: [], error: null })
          }),
        }
      }
      // journal_entries
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: (resolve: (v: QueryResult) => void) => resolve(entriesResult),
      }
    }),
  }
  return Object.assign(supabase, { rangeCalls, orderCalls })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/supplier-ledger/supplier/[supplierId]/invoices', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: buildSupabase(null, { data: [], error: null }, { data: [], error: null }),
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const req = createMockRequest(
      '/api/reports/supplier-ledger/supplier/sup-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ supplierId: 'sup-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when supplier is unknown', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: buildSupabase(null, { data: [], error: null }, { data: [], error: null }),
      error: null,
    })
    const req = createMockRequest(
      '/api/reports/supplier-ledger/supplier/sup-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ supplierId: 'sup-1' }))
    expect(res.status).toBe(404)
  })

  it('happy path: returns supplier invoices with journal entries', async () => {
    const invoices = [
      {
        id: 'si-1',
        supplier_invoice_number: 'INV-7',
        invoice_date: '2026-05-10',
        due_date: '2026-06-10',
        total: 2500,
        paid_amount: 0,
        remaining_amount: 2500,
        currency: 'SEK',
        exchange_rate: null,
        registration_journal_entry_id: 'je-3',
      },
    ]
    const entries = [
      {
        id: 'je-3',
        voucher_number: 33,
        voucher_series: 'B',
        description: 'Leverantörsfaktura INV-7',
        entry_date: '2026-05-10',
      },
    ]
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: buildSupabase(
        { id: 'sup-1', name: 'Office Supply AB' },
        { data: invoices, error: null },
        { data: entries, error: null }
      ),
      error: null,
    })
    const req = createMockRequest(
      '/api/reports/supplier-ledger/supplier/sup-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ supplierId: 'sup-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        supplier_id: string
        supplier_name: string
        lines: Array<{
          supplier_invoice_id: string
          journal_entry_id: string
          voucher_number: number
          credit: number
        }>
      }
    }

    expect(body.data.supplier_id).toBe('sup-1')
    expect(body.data.supplier_name).toBe('Office Supply AB')
    expect(body.data.lines).toHaveLength(1)
    expect(body.data.lines[0].supplier_invoice_id).toBe('si-1')
    expect(body.data.lines[0].journal_entry_id).toBe('je-3')
    expect(body.data.lines[0].voucher_number).toBe(33)
    expect(body.data.lines[0].credit).toBe(2500)
  })

  it('never reports a foreign amount as SEK when the exchange rate is missing', async () => {
    // 1 000 EUR with no rate: there is no SEK figure for the 2440 balance, so
    // the Kredit column (always SEK) must not be handed the EUR number.
    const invoices = [
      {
        id: 'si-fx',
        supplier_invoice_number: 'EUR-1',
        invoice_date: '2026-05-10',
        due_date: '2026-06-10',
        total: 1000,
        paid_amount: 0,
        remaining_amount: 1000,
        currency: 'EUR',
        exchange_rate: null,
        registration_journal_entry_id: null,
      },
    ]
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: buildSupabase(
        { id: 'sup-1', name: 'Euro Supply GmbH' },
        { data: invoices, error: null },
        { data: [], error: null }
      ),
      error: null,
    })
    const req = createMockRequest(
      '/api/reports/supplier-ledger/supplier/sup-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ supplierId: 'sup-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        unconverted_fx_count: number
        lines: Array<{
          credit: number
          remaining: number
          remaining_sek: number | null
          currency: string
        }>
      }
    }

    const line = body.data.lines[0]
    // The EUR amount must not leak into the SEK column.
    expect(line.credit).not.toBe(1000)
    expect(line.credit).toBe(0)
    // ... but the invoice stays visible, with its own-currency amount intact.
    expect(line.remaining).toBe(1000)
    expect(line.currency).toBe('EUR')
    // Explicit null marker + count, same contract as the ledger report.
    expect(line.remaining_sek).toBeNull()
    expect(body.data.unconverted_fx_count).toBe(1)
  })

  it('lets the consumer tell an unconverted row from a settled one', async () => {
    const invoices = [
      // Unconvertible: SEK value unknown.
      {
        id: 'si-fx',
        supplier_invoice_number: 'EUR-1',
        invoice_date: '2026-05-10',
        due_date: '2026-06-10',
        total: 1000,
        paid_amount: 0,
        remaining_amount: 1000,
        currency: 'EUR',
        exchange_rate: null,
        registration_journal_entry_id: null,
      },
      // Convertible: 100 EUR at 11.50.
      {
        id: 'si-fx-rate',
        supplier_invoice_number: 'EUR-2',
        invoice_date: '2026-05-11',
        due_date: '2026-06-11',
        total: 100,
        paid_amount: 0,
        remaining_amount: 100,
        currency: 'EUR',
        exchange_rate: 11.5,
        registration_journal_entry_id: null,
      },
      // Genuinely settled: nothing left on 2440.
      {
        id: 'si-settled',
        supplier_invoice_number: 'SEK-1',
        invoice_date: '2026-05-12',
        due_date: '2026-06-12',
        total: 500,
        paid_amount: 500,
        remaining_amount: 0,
        currency: 'SEK',
        exchange_rate: null,
        registration_journal_entry_id: null,
      },
    ]
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: buildSupabase(
        { id: 'sup-1', name: 'Euro Supply GmbH' },
        { data: invoices, error: null },
        { data: [], error: null }
      ),
      error: null,
    })
    const req = createMockRequest(
      '/api/reports/supplier-ledger/supplier/sup-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ supplierId: 'sup-1' }))

    const body = (await res.json()) as {
      data: {
        unconverted_fx_count: number
        lines: Array<{
          supplier_invoice_id: string
          credit: number
          remaining_sek: number | null
        }>
      }
    }

    const byId = new Map(body.data.lines.map((l) => [l.supplier_invoice_id, l]))
    // Unknown SEK value: null, not 0.
    expect(byId.get('si-fx')!.remaining_sek).toBeNull()
    // Settled: 0, not null.
    expect(byId.get('si-settled')!.remaining_sek).toBe(0)
    // Converted rows are unaffected: still the SEK amount in the Kredit column.
    expect(byId.get('si-fx-rate')!.remaining_sek).toBe(1150)
    expect(byId.get('si-fx-rate')!.credit).toBe(1150)
    expect(body.data.unconverted_fx_count).toBe(1)
  })

  it('paginates past the old hardcoded cap and counts FX rows over the full set', async () => {
    // 1000 SEK invoices fill page one; page two carries one more SEK invoice
    // plus an unconvertible FX invoice. The old 500-row limit truncated both
    // the lines AND unconverted_fx_count while next_cursor: null claimed the
    // list was complete.
    const makeInvoice = (i: number) => ({
      id: `si-${i}`,
      supplier_invoice_number: `INV-${i}`,
      invoice_date: '2026-05-10',
      due_date: '2026-06-10',
      total: 100,
      paid_amount: 0,
      remaining_amount: 100,
      currency: 'SEK',
      exchange_rate: null,
      registration_journal_entry_id: null,
    })
    const page1 = Array.from({ length: 1000 }, (_, i) => makeInvoice(i))
    const page2 = [
      makeInvoice(1000),
      { ...makeInvoice(1001), currency: 'EUR', exchange_rate: null },
    ]

    const supabase = buildSupabase(
      { id: 'sup-1', name: 'Volym AB' },
      [
        { data: page1, error: null },
        { data: page2, error: null },
      ],
      { data: [], error: null }
    )
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const res = await GET(
      createMockRequest('/api/reports/supplier-ledger/supplier/sup-1/invoices'),
      createMockRouteParams({ supplierId: 'sup-1' })
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        lines: Array<{ remaining_sek: number | null }>
        unconverted_fx_count: number
        next_cursor: null
      }
    }

    // Every row made it through, not just the first page.
    expect(body.data.lines).toHaveLength(1002)
    expect(supabase.rangeCalls).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    // Stable paging order: invoice_date is not unique, so id must break ties.
    expect(supabase.orderCalls).toContainEqual(['invoice_date', { ascending: true }])
    expect(supabase.orderCalls).toContainEqual(['id', { ascending: true }])
    // The honesty counter sees the FX row on page two.
    expect(body.data.unconverted_fx_count).toBe(1)
    // The shape is unchanged, and the null cursor is now truthful.
    expect(body.data.next_cursor).toBeNull()
  })
})
