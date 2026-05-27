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
  customer: { id: string; name: string } | null,
  invoicesResult: QueryResult,
  entriesResult: QueryResult
) {
  let invoiceCallNum = 0
  let entryCallNum = 0
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'customers') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: customer, error: null }),
        }
      }
      if (table === 'invoices') {
        invoiceCallNum += 1
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
      entryCallNum += 1
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: (resolve: (v: QueryResult) => void) => resolve(entriesResult),
      }
    }),
    _stats: () => ({ invoiceCallNum, entryCallNum }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/ar-ledger/customer/[customerId]/invoices', () => {
  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase(null, null, { data: [], error: null }, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when customer is unknown', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, null, { data: [], error: null }, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(404)
  })

  it('happy path: returns invoices with linked journal entries', async () => {
    const invoices = [
      {
        id: 'inv-1',
        invoice_number: '2026-001',
        invoice_date: '2026-05-01',
        due_date: '2026-06-01',
        total: 1250,
        paid_amount: 0,
        currency: 'SEK',
        exchange_rate: null,
        remaining_amount: 1250,
        notes: null,
      },
    ]
    const entries = [
      {
        id: 'je-1',
        voucher_number: 22,
        voucher_series: 'A',
        description: 'Faktura 2026-001',
        source_id: 'inv-1',
      },
    ]
    mockCreateClient.mockResolvedValue(
      buildSupabase(
        { id: 'user-1' },
        { id: 'cust-1', name: 'Acme AB' },
        { data: invoices, error: null },
        { data: entries, error: null }
      ) as never
    )
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        customer_id: string
        customer_name: string
        lines: Array<{
          invoice_id: string
          voucher_number: number
          journal_entry_id: string
          outstanding: number
        }>
      }
    }

    expect(body.data.customer_id).toBe('cust-1')
    expect(body.data.customer_name).toBe('Acme AB')
    expect(body.data.lines).toHaveLength(1)
    expect(body.data.lines[0].invoice_id).toBe('inv-1')
    expect(body.data.lines[0].journal_entry_id).toBe('je-1')
    expect(body.data.lines[0].voucher_number).toBe(22)
    expect(body.data.lines[0].outstanding).toBe(1250)
  })
})
