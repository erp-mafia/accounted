import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

// Stub the PDF renderer so the test never spins up real PDF layout. Provide the
// primitives the template imports at module load (StyleSheet.create runs then).
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
  StyleSheet: { create: (s: unknown) => s },
  Document: (p: unknown) => p,
  Page: (p: unknown) => p,
  Text: (p: unknown) => p,
  View: (p: unknown) => p,
}))

vi.mock('@/lib/reports/supplier-ledger', () => ({
  generateSupplierLedger: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function companySettingsQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  }
}

function makeLedger() {
  return {
    entries: [
      {
        supplier_id: 'sup-1',
        supplier_name: 'Leverantören AB',
        current: 500,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 500,
      },
    ],
    total_outstanding: 500,
    total_current: 500,
    total_overdue: 0,
    unpaid_count: 1,
    unconverted_fx_count: 0,
  }
}

function makeRequest(query = '') {
  return new Request(`http://localhost/api/reports/supplier-ledger/pdf${query}`)
}

describe('GET /api/reports/supplier-ledger/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    mockSupabase.from.mockReturnValue(
      companySettingsQuery({ company_name: 'Testbolaget AB', org_number: '5566778899' }),
    )
    vi.mocked(generateSupplierLedger).mockResolvedValue(makeLedger() as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(makeRequest(), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed as_of_date', async () => {
    const res = await GET(makeRequest('?as_of_date=2026-6-1'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(400)
    expect(generateSupplierLedger).not.toHaveBeenCalled()
  })

  it('returns 404 when company settings are missing', async () => {
    mockSupabase.from.mockReturnValue(companySettingsQuery(null))

    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(404)
  })

  it('renders a PDF for the requested as-of date', async () => {
    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('leverantorsreskontra')
    expect(res.headers.get('Content-Disposition')).toContain('20260630')
    expect(generateSupplierLedger).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-06-30')
  })

  it('returns 500 when the generator throws', async () => {
    vi.mocked(generateSupplierLedger).mockRejectedValue(new Error('boom'))

    const res = await GET(makeRequest('?as_of_date=2026-06-30'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(500)
  })
})

// The shared route-wrapper tests cover the database read lease.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))
