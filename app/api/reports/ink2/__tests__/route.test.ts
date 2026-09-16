/**
 * Tests for GET /api/reports/ink2 (cookie session, withRouteContext). The
 * declaration engine is mocked; the wrapper, the query validation and the
 * JSON/SRU branches are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}))
// The shared route-wrapper tests cover the database read lease.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))
const generateMock = vi.fn()
vi.mock('@/lib/reports/ink2/ink2-engine', () => ({
  generateINK2Declaration: (...args: unknown[]) => generateMock(...args),
}))

import { GET } from '../route'

const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
const routeCtx = createMockRouteParams({})

/** A minimal declaration: only what the route and the SRU writer touch. */
function makeDeclaration() {
  const ink2r: Record<string, number> = {}
  return {
    fiscalYear: { id: PERIOD_ID, name: 'Räkenskapsår 2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
    ink2: { '7011': '20250101', '7012': '20251231', '7104': 406_000, '7114': 0 },
    ink2r,
    ink2s: {
      '7011': '20250101',
      '7012': '20251231',
      '7650': 442_000,
      '7750': 0,
      '7651': 60_000,
      '7653': 4_000,
      '7754': 0,
      '7763': 100_000,
      '8020': 406_000,
      '8021': 0,
    },
    breakdown: {},
    totals: { totalAssets: 0, totalEquityLiabilities: 0, operatingResult: 0, aretsResultat: 442_000 },
    companyInfo: {
      companyName: 'Test AB',
      orgNumber: '556677-8899',
      addressLine1: null,
      postalCode: '11122',
      city: 'Stockholm',
      email: null,
    },
    warnings: [],
  }
}

describe('GET /api/reports/ink2', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    generateMock.mockResolvedValue(makeDeclaration())
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await GET(createMockRequest(`http://localhost/api/reports/ink2?period_id=${PERIOD_ID}`), routeCtx)
    expect(res.status).toBe(401)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('400s a missing period_id with the typed code', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('http://localhost/api/reports/ink2'), routeCtx),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('REPORT_PERIOD_REQUIRED')
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('returns the declaration as JSON, carrying the prior-year deficit on 7763', async () => {
    const res = await GET(createMockRequest(`http://localhost/api/reports/ink2?period_id=${PERIOD_ID}`), routeCtx)
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { ink2s: Record<string, number> } }>(res)
    expect(body.data.ink2s['7763']).toBe(100_000)
    expect(body.data.ink2s['8020']).toBe(406_000)
    expect(generateMock).toHaveBeenCalledWith(supabase, 'company-1', PERIOD_ID)
  })

  it('500s a generator failure with the typed code and no stack leak', async () => {
    generateMock.mockRejectedValue(new Error('Fiscal period not found'))
    const res = await GET(createMockRequest(`http://localhost/api/reports/ink2?period_id=${PERIOD_ID}`), routeCtx)
    expect(res.status).toBe(500)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('TAX_DECL_GENERATION_FAILED')
  })
})
