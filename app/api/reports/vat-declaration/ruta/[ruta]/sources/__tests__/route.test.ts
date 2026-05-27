import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { createClient } from '@/lib/supabase/server'
import { GET } from '../route'

const mockCreateClient = vi.mocked(createClient)

function buildSupabase(
  user: { id: string } | null,
  linesResult: { data: unknown; error: unknown }
) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve(linesResult),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/vat-declaration/ruta/[ruta]/sources', () => {
  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase(null, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources',
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when period params are missing', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources'
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when ruta has no underlying BAS accounts', async () => {
    mockCreateClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, { data: [], error: null }) as never
    )
    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/99/sources',
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '99' }))
    expect(res.status).toBe(404)
  })

  it('happy path: returns mapped lines for ruta10', async () => {
    const linesData = [
      {
        account_number: '2611',
        debit_amount: 0,
        credit_amount: 250,
        journal_entries: {
          id: 'je-1',
          voucher_number: 12,
          voucher_series: 'A',
          entry_date: '2026-05-12',
          description: 'Faktura 1001',
          status: 'posted',
          company_id: 'company-1',
        },
      },
    ]
    mockCreateClient.mockResolvedValue(
      buildSupabase({ id: 'user-1' }, { data: linesData, error: null }) as never
    )

    const req = createMockRequest(
      '/api/reports/vat-declaration/ruta/10/sources',
      { searchParams: { periodType: 'monthly', year: '2026', period: '5' } }
    )
    const res = await GET(req, createMockRouteParams({ ruta: '10' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        ruta: string
        lines: Array<{ voucher_number: number; credit: number }>
      }
    }

    expect(body.data.ruta).toBe('ruta10')
    expect(body.data.lines).toHaveLength(1)
    expect(body.data.lines[0].voucher_number).toBe(12)
    expect(body.data.lines[0].credit).toBe(250)
  })
})
