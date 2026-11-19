/**
 * Tests for /api/reports/vat-declaration/check-reviews (crm#1171): a person
 * marks a momsdeklaration WARNING reviewed for a period, reads the period's
 * reviews, and takes one back. The service and store are mocked (they have
 * their own tests in lib/vat/__tests__); what matters here is the wrapper
 * contract (401/403), the Zod contract (400), the code-to-status mapping of
 * the service's refusals (404/409) and that the web door writes as 'web'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const serviceClient = { service: true }
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => serviceClient),
}))

const declaration = vi.hoisted(() => ({
  resolvePeriodDates: vi.fn(),
}))
vi.mock('@/lib/reports/vat-declaration', () => declaration)

const store = vi.hoisted(() => ({ listVatCheckReviews: vi.fn() }))
vi.mock('@/lib/vat/check-review-store', () => store)

const service = vi.hoisted(() => ({
  markVatCheckReviewed: vi.fn(),
  withdrawVatCheckReview: vi.fn(),
}))
vi.mock('@/lib/vat/check-review-service', () => service)

import { GET as getRoute, POST as postRoute, DELETE as deleteRoute } from '../route'

const noParams = () => ({ params: Promise.resolve({}) })
const GET = (request: Request) => getRoute(request, noParams())
const POST = (request: Request) => postRoute(request, noParams())
const DELETE = (request: Request) => deleteRoute(request, noParams())

const PATH = '/api/reports/vat-declaration/check-reviews'
const FISCAL_PERIOD_ID = '22222222-2222-4222-8222-222222222222'
const YEARLY = { period_type: 'yearly', year: 2026, period: 1, fiscal_period_id: FISCAL_PERIOD_ID }
const validBody = { ...YEARLY, check_code: 'RC_BASIS_MISSING', note: 'Basbeloppet är bokat i A61' }

const REVIEW = {
  check_code: 'RC_BASIS_MISSING',
  fingerprint: 'v1:0123456789abcdef',
  reviewed_at: '2026-10-15T09:00:00Z',
  reviewed_by: 'user-1',
  reviewed_by_label: 'Fredrik',
  note: 'Basbeloppet är bokat i A61',
  source: 'web',
}

function auth() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
}

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: {},
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
  declaration.resolvePeriodDates.mockResolvedValue({ start: '2025-10-19', end: '2026-09-30', source: 'fiscal_period' })
})

describe('GET /api/reports/vat-declaration/check-reviews', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await GET(createMockRequest(PATH, { searchParams: { period_type: 'quarterly', year: '2026', period: '1' } }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for a period the cadence does not have', async () => {
    auth()
    const res = await GET(createMockRequest(PATH, { searchParams: { period_type: 'quarterly', year: '2026', period: '5' } }))
    expect(res.status).toBe(400)
    expect(store.listVatCheckReviews).not.toHaveBeenCalled()
  })

  it('lists the reviews of the period its dates resolve to, the räkenskapsår included', async () => {
    auth()
    store.listVatCheckReviews.mockResolvedValue([REVIEW])
    const res = await GET(
      createMockRequest(PATH, {
        searchParams: { period_type: 'yearly', year: '2026', period: '1', fiscal_period_id: FISCAL_PERIOD_ID },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual([REVIEW])
    expect(declaration.resolvePeriodDates).toHaveBeenCalledWith({}, 'company-1', 'yearly', 2026, 1, FISCAL_PERIOD_ID)
    expect(store.listVatCheckReviews).toHaveBeenCalledWith(
      {},
      'company-1',
      { start: '2025-10-19', end: '2026-09-30' },
      { labelClient: serviceClient },
    )
  })
})

describe('POST /api/reports/vat-declaration/check-reviews', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await POST(createMockRequest(PATH, { method: 'POST', body: validBody }))
    expect(res.status).toBe(401)
    expect(service.markVatCheckReviewed).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    auth()
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    const res = await POST(createMockRequest(PATH, { method: 'POST', body: validBody }))
    expect(res.status).toBe(403)
    expect(service.markVatCheckReviewed).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown check code, a malformed fingerprint or an overlong note', async () => {
    auth()
    for (const body of [
      { ...validBody, check_code: 'NOT_A_CHECK' },
      { ...validBody, expected_fingerprint: 'deadbeef' },
      { ...validBody, note: 'x'.repeat(1001) },
      { ...validBody, period: 2 },
    ]) {
      const res = await POST(createMockRequest(PATH, { method: 'POST', body }))
      expect(res.status).toBe(400)
    }
    expect(service.markVatCheckReviewed).not.toHaveBeenCalled()
  })

  it('answers 404 when the period no longer shows the finding', async () => {
    auth()
    service.markVatCheckReviewed.mockResolvedValue({ ok: false, code: 'VAT_CHECK_NOT_FOUND' })
    const res = await POST(createMockRequest(PATH, { method: 'POST', body: validBody }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('VAT_CHECK_NOT_FOUND')
  })

  it('answers 409 for an ERROR and for figures that moved since the user saw them', async () => {
    auth()
    for (const code of ['VAT_CHECK_NOT_REVIEWABLE', 'VAT_CHECK_CHANGED']) {
      service.markVatCheckReviewed.mockResolvedValueOnce({ ok: false, code })
      const res = await POST(createMockRequest(PATH, { method: 'POST', body: validBody }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
      expect(status).toBe(409)
      expect(body.error.code).toBe(code)
    }
  })

  it('records the review in the person\'s own name as a web review', async () => {
    auth()
    const marked = { ...REVIEW, period: { type: 'yearly', start: '2025-10-19', end: '2026-09-30' }, changed: true }
    service.markVatCheckReviewed.mockResolvedValue({ ok: true, data: marked })
    const res = await POST(
      createMockRequest(PATH, { method: 'POST', body: { ...validBody, expected_fingerprint: 'v1:0123456789abcdef' } }),
    )
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(marked)
    expect(service.markVatCheckReviewed).toHaveBeenCalledWith({}, 'company-1', 'user-1', {
      periodType: 'yearly',
      year: 2026,
      period: 1,
      fiscalPeriodId: FISCAL_PERIOD_ID,
      checkCode: 'RC_BASIS_MISSING',
      note: 'Basbeloppet är bokat i A61',
      expectedFingerprint: 'v1:0123456789abcdef',
      source: 'web',
    })
  })
})

describe('DELETE /api/reports/vat-declaration/check-reviews', () => {
  const query = { period_type: 'quarterly', year: '2026', period: '1', check_code: 'RC_INPUT_VAT_MISMATCH' }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await DELETE(createMockRequest(PATH, { method: 'DELETE', searchParams: query }))
    expect(res.status).toBe(401)
  })

  it('returns 400 without a check code', async () => {
    auth()
    const res = await DELETE(
      createMockRequest(PATH, { method: 'DELETE', searchParams: { period_type: 'quarterly', year: '2026', period: '1' } }),
    )
    expect(res.status).toBe(400)
    expect(service.withdrawVatCheckReview).not.toHaveBeenCalled()
  })

  it('answers 404 when nothing is reviewed', async () => {
    auth()
    service.withdrawVatCheckReview.mockResolvedValue({ ok: false, code: 'VAT_CHECK_REVIEW_NOT_FOUND' })
    const res = await DELETE(createMockRequest(PATH, { method: 'DELETE', searchParams: query }))
    expect(res.status).toBe(404)
  })

  it('takes the review back', async () => {
    auth()
    const data = { period: { type: 'quarterly', start: '2026-01-01', end: '2026-03-31' }, check_code: 'RC_INPUT_VAT_MISMATCH', withdrawn: true }
    service.withdrawVatCheckReview.mockResolvedValue({ ok: true, data })
    const res = await DELETE(createMockRequest(PATH, { method: 'DELETE', searchParams: query }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    expect(service.withdrawVatCheckReview).toHaveBeenCalledWith({}, 'company-1', 'user-1', {
      periodType: 'quarterly',
      year: 2026,
      period: 1,
      fiscalPeriodId: undefined,
      checkCode: 'RC_INPUT_VAT_MISMATCH',
      source: 'web',
    })
  })
})
