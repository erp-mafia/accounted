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
import { reskontraRpcPorts, type ReskontraTables } from '@/tests/reskontra-rpc-port'

/**
 * The supplier lookup is a table read; the invoices and their registration
 * verifikat come from get_supplier_ledger_invoices, answered from `books` by
 * its JS port (tests/reskontra-rpc-port.ts). Invoices are the supplier's
 * ('sup-1') and approved unless they say otherwise.
 */
function buildSupabase(
  supplier: { id: string; name: string } | null,
  books: ReskontraTables,
  failures: Record<string, { message: string }> = {},
) {
  const tables: ReskontraTables = {
    ...books,
    supplier_invoices: (books.supplier_invoices ?? []).map((row) => ({ supplier_id: 'sup-1', status: 'approved', ...row })),
  }
  return {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (failures[name]) return { data: null, error: failures[name] }
      return { data: reskontraRpcPorts(tables)[name](args), error: null }
    }),
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'suppliers') throw new Error(`unexpected read of ${table}`)
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: supplier, error: null }),
      }
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/supplier-ledger/supplier/[supplierId]/invoices', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: buildSupabase(null, {}),
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
      supabase: buildSupabase(null, {}),
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
        status: 'posted',
        voucher_number: 33,
        voucher_series: 'B',
        description: 'Leverantörsfaktura INV-7',
        entry_date: '2026-05-10',
      },
    ]
    const supabase = buildSupabase(
      { id: 'sup-1', name: 'Office Supply AB' },
      { supplier_invoices: invoices, journal_entries: entries },
    )
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
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

    // One read of the supplier's open invoices, verifikat included.
    expect(supabase.rpc).toHaveBeenCalledWith('get_supplier_ledger_invoices', {
      p_company_id: 'company-1',
      p_as_of_date: null,
      p_supplier_id: 'sup-1',
    })
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
      supabase: buildSupabase({ id: 'sup-1', name: 'Euro Supply GmbH' }, { supplier_invoices: invoices }),
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
      supabase: buildSupabase({ id: 'sup-1', name: 'Euro Supply GmbH' }, { supplier_invoices: invoices }),
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

  it('lists every open invoice in invoice-date order and counts FX rows over the full set', async () => {
    // 1001 SEK invoices and an unconvertible FX invoice, past PostgREST's
    // 1000-row page. The old 500-row limit truncated both the lines AND
    // unconverted_fx_count while next_cursor: null claimed the list was
    // complete.
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
    const invoices = [
      { ...makeInvoice(1001), currency: 'EUR', exchange_rate: null, invoice_date: '2026-05-01' },
      ...Array.from({ length: 1001 }, (_, i) => makeInvoice(i)),
    ]

    const supabase = buildSupabase({ id: 'sup-1', name: 'Volym AB' }, { supplier_invoices: invoices })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const res = await GET(
      createMockRequest('/api/reports/supplier-ledger/supplier/sup-1/invoices'),
      createMockRouteParams({ supplierId: 'sup-1' })
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        lines: Array<{ supplier_invoice_id: string; remaining_sek: number | null }>
        unconverted_fx_count: number
        next_cursor: null
      }
    }

    // Every row made it through, by invoice date (the FX invoice is the
    // earliest), then in the read's id order.
    expect(body.data.lines).toHaveLength(1002)
    expect(body.data.lines[0].supplier_invoice_id).toBe('si-1001')
    expect(body.data.lines[1].supplier_invoice_id).toBe('si-0')
    // The honesty counter sees the FX row on page two.
    expect(body.data.unconverted_fx_count).toBe(1)
    // The shape is unchanged, and the null cursor is now truthful.
    expect(body.data.next_cursor).toBeNull()
  })
})
