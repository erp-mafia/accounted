import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/bookkeeping/currency-utils', () => ({
  resolveSekAmount: vi.fn((amount: number) => amount),
}))

import { createClient } from '@/lib/supabase/server'
import { GET } from '../route'

const mockCreateClient = vi.mocked(createClient)

interface QueryResult {
  data: unknown
  error: unknown
}

function buildSupabase(
  user: { id: string } | null,
  supplier: { id: string; name: string } | null,
  invoicesResult: QueryResult,
  entriesResult: QueryResult
) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
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
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (resolve: (v: QueryResult) => void) => resolve(invoicesResult),
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
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/supplier-ledger/supplier/[supplierId]/invoices', () => {
  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase(null, null, { data: [], error: null }, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/supplier-ledger/supplier/sup-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ supplierId: 'sup-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when supplier is unknown', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, null, { data: [], error: null }, { data: [], error: null }) as never
    )
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
    mockCreateClient.mockResolvedValue(
      buildSupabase(
        { id: 'user-1' },
        { id: 'sup-1', name: 'Office Supply AB' },
        { data: invoices, error: null },
        { data: entries, error: null }
      ) as never
    )
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
})
