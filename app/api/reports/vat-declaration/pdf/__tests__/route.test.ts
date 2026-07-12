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

vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: vi.fn(),
  formatPeriodLabel: vi.fn(() => 'Kvartal 3 2026'),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function companySettingsQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  }
}

function makeDeclaration() {
  return {
    period: { start: '2026-07-01', end: '2026-09-30' },
    rutor: {
      ruta05: 100000, ruta06: 0, ruta07: 0, ruta08: 0,
      ruta10: 25000, ruta11: 0, ruta12: 0,
      ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
      ruta30: 0, ruta31: 0, ruta32: 0,
      ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0, ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
      ruta48: 3200,
      ruta49: 21800,
      ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
    },
  }
}

describe('GET /api/reports/vat-declaration/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    mockSupabase.from.mockReturnValue(
      companySettingsQuery({
        company_name: 'Testbolaget AB',
        org_number: '5566778899',
        vat_number: 'SE556677889901',
        accounting_method: 'accrual',
      }),
    )
    vi.mocked(calculateVatDeclaration).mockResolvedValue(makeDeclaration() as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/pdf?periodType=quarterly&year=2026&period=3',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('returns 400 when period params are missing', async () => {
    const req = new Request('http://localhost/api/reports/vat-declaration/pdf')
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
  })

  it('returns 404 when company settings are missing', async () => {
    mockSupabase.from.mockReturnValue(companySettingsQuery(null))
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/pdf?periodType=quarterly&year=2026&period=3',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(404)
  })

  it('happy path: returns a PDF attachment', async () => {
    const req = new Request(
      'http://localhost/api/reports/vat-declaration/pdf?periodType=quarterly&year=2026&period=3',
    )
    const res = await GET(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('momsdeklaration-2026-07-01--2026-09-30.pdf')
    expect(calculateVatDeclaration).toHaveBeenCalledOnce()
  })
})
