import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The underlag itself is covered in lib/webshop-orders/__tests__; here only
// the HTTP contract of the two doors.
const getOssUnderlag = vi.fn()
vi.mock('@/lib/webshop-orders/oss-underlag', () => ({
  getOssUnderlag: (...args: unknown[]) => getOssUnderlag(...args),
}))

import { GET } from '../oss-underlag/route'
import { GET as GET_XLSX } from '../oss-underlag/xlsx/route'

const routeCtx = createMockRouteParams({})

const UNDERLAG = {
  period: { year: 2026, quarter: 3, start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026', deadline: '2026-10-31' },
  rows: [{ country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1, voucher_count: 1, rate_mismatch: true }],
  corrections: [
    { country: 'DE', period: { year: 2026, quarter: 2, label: 'Q2 2026' }, vat_eur: -3.49, vat_sek: -38, refund_count: 1, voucher_count: 0 },
  ],
  totals: { net_eur: 88.25, vat_eur: 16.77, corrections_vat_eur: -3.49, net_sek: 1000, vat_sek: 190, corrections_vat_sek: -38 },
  rates: [{ currency: 'SEK', for_date: '2026-09-30', rate: 11.331, rate_date: '2026-09-30', unavailable: false }],
  ledger_vat_sek: 152,
  unaccounted: [],
  refund_vouchers: [
    { journal_entry_id: 'e2', voucher_series: 'A', voucher_number: 2, entry_date: '2026-08-15', description: 'Kreditfaktura', net_sek: -400, vat_sek: -76 },
  ],
  accounts: [],
  warnings: [],
  nil_return: false,
}

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
})

describe('GET /api/webshop-orders/oss-underlag', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest('/api/webshop-orders/oss-underlag?year=2026&quarter=3'), routeCtx)
    expect(response.status).toBe(401)
    expect(getOssUnderlag).not.toHaveBeenCalled()
  })

  it('returns 400 for a quarter that is not 1-4 or a year before the scheme', async () => {
    for (const query of ['year=2026&quarter=5', 'year=2020&quarter=1', 'quarter=3']) {
      const response = await GET(createMockRequest(`/api/webshop-orders/oss-underlag?${query}`), routeCtx)
      expect(response.status, query).toBe(400)
    }
    expect(getOssUnderlag).not.toHaveBeenCalled()
  })

  it('answers the underlag for the company and quarter', async () => {
    getOssUnderlag.mockResolvedValue({ ok: true, data: UNDERLAG })

    const response = await GET(createMockRequest('/api/webshop-orders/oss-underlag?year=2026&quarter=3'), routeCtx)

    expect(response.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: typeof UNDERLAG }>(response)
    expect(body.data).toEqual(UNDERLAG)
    expect(getOssUnderlag).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      { year: 2026, quarter: 3 },
    )
  })

  it('answers the structured error when the underlag cannot be built', async () => {
    getOssUnderlag.mockResolvedValue({ ok: false, code: 'OSS_UNDERLAG_FAILED', details: { reason: 'timeout' } })

    const response = await GET(createMockRequest('/api/webshop-orders/oss-underlag?year=2026&quarter=3'), routeCtx)

    expect(response.status).toBe(500)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(body.error.code).toBe('OSS_UNDERLAG_FAILED')
  })
})

describe('GET /api/webshop-orders/oss-underlag/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET_XLSX(createMockRequest('/api/webshop-orders/oss-underlag/xlsx?year=2026&quarter=3'), routeCtx)
    expect(response.status).toBe(401)
  })

  it('returns 400 for a bad quarter', async () => {
    const response = await GET_XLSX(createMockRequest('/api/webshop-orders/oss-underlag/xlsx?year=2026&quarter=0'), routeCtx)
    expect(response.status).toBe(400)
  })

  it('streams the workbook named after the company and the quarter', async () => {
    getOssUnderlag.mockResolvedValue({ ok: true, data: UNDERLAG })
    enqueue({ data: { company_name: 'Testbolaget AB' } })

    const response = await GET_XLSX(createMockRequest('/api/webshop-orders/oss-underlag/xlsx?year=2026&quarter=3'), routeCtx)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.headers.get('content-disposition')).toContain('oss-underlag')
    const bytes = new Uint8Array(await response.arrayBuffer())
    // An xlsx is a zip: it starts with PK.
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b])
  })
})
