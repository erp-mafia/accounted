/**
 * Tests for GET/POST /api/bookkeeping/fiscal-periods/[id]/reset.
 *
 * Exercises the routes through the real withRouteContext wrapper, mocking its
 * auth/company/write dependencies and the fiscal-year-reset service. Covers:
 * 401, 403 viewer, validation 400, 404, the eligibility passthrough, the
 * happy path, and every refusal envelope (ineligible with blockers,
 * confirmation mismatch, linked entries).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

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

const getEligibilityMock = vi.fn()
const resetFiscalYearMock = vi.fn()
vi.mock('@/lib/core/bookkeeping/fiscal-year-reset', () => ({
  getFiscalYearResetEligibility: (...args: unknown[]) => getEligibilityMock(...args),
  resetFiscalYear: (...args: unknown[]) => resetFiscalYearMock(...args),
}))

import { GET, POST } from '../route'

const routeParams = () => createMockRouteParams({ id: 'period-1' })

const ELIGIBILITY = {
  eligible: true,
  blockers: [],
  period: {
    id: 'period-1',
    name: '2026',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
  },
  counts: { vouchers: 42, documents_to_detach: 3 },
}

describe('GET /api/bookkeeping/fiscal-periods/[id]/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/reset'),
      routeParams(),
    )

    expect(response.status).toBe(401)
    expect(getEligibilityMock).not.toHaveBeenCalled()
  })

  it('returns the eligibility preview', async () => {
    getEligibilityMock.mockResolvedValue({ ok: true, eligibility: ELIGIBILITY })

    const response = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/reset'),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof ELIGIBILITY }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(ELIGIBILITY)
    expect(getEligibilityMock).toHaveBeenCalledWith(supabase, 'company-1', 'period-1')
  })

  it('returns 404 when the period does not exist', async () => {
    getEligibilityMock.mockResolvedValue({ ok: false, code: 'FISCAL_YEAR_RESET_NOT_FOUND' })

    const response = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/reset'),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('FISCAL_YEAR_RESET_NOT_FOUND')
  })

  it('returns 403 when the caller is not owner/admin', async () => {
    getEligibilityMock.mockResolvedValue({ ok: false, code: 'FISCAL_YEAR_RESET_FORBIDDEN' })

    const response = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/reset'),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FISCAL_YEAR_RESET_FORBIDDEN')
  })

  it('maps unexpected codes to the generic 500 envelope', async () => {
    getEligibilityMock.mockResolvedValue({ ok: false, code: 'SOMETHING_ELSE' })

    const response = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/reset'),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('FISCAL_YEAR_RESET_FAILED')
  })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  const postRequest = (body?: unknown) =>
    createMockRequest('/api/bookkeeping/fiscal-periods/period-1/reset', {
      method: 'POST',
      body: body ?? { confirm_name: '2026' },
    })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(postRequest(), routeParams())

    expect(response.status).toBe(401)
    expect(resetFiscalYearMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(postRequest(), routeParams())

    expect(response.status).toBe(403)
    expect(resetFiscalYearMock).not.toHaveBeenCalled()
  })

  it('returns 400 when confirm_name is missing', async () => {
    const response = await POST(postRequest({}), routeParams())

    expect(response.status).toBe(400)
    expect(resetFiscalYearMock).not.toHaveBeenCalled()
  })

  it('executes the reset and returns the counts', async () => {
    resetFiscalYearMock.mockResolvedValue({
      ok: true,
      deleted: 42,
      detachedDocuments: 3,
      periodName: '2026',
    })

    const response = await POST(postRequest(), routeParams())
    const { status, body } = await parseJsonResponse<{
      data: { deleted: number; detachedDocuments: number; periodName: string }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ deleted: 42, detachedDocuments: 3, periodName: '2026' })
    expect(resetFiscalYearMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      'user-1',
      '2026',
    )
  })

  it('returns 409 with blockers when the year is ineligible (e.g. locked)', async () => {
    resetFiscalYearMock.mockResolvedValue({
      ok: false,
      code: 'FISCAL_YEAR_RESET_INELIGIBLE',
      blockers: [{ code: 'period_locked' }],
    })

    const response = await POST(postRequest(), routeParams())
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { blockers?: Array<{ code: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('FISCAL_YEAR_RESET_INELIGIBLE')
    expect(body.error.details?.blockers).toEqual([{ code: 'period_locked' }])
  })

  it('returns 400 on confirmation mismatch', async () => {
    resetFiscalYearMock.mockResolvedValue({
      ok: false,
      code: 'FISCAL_YEAR_RESET_CONFIRMATION_MISMATCH',
    })

    const response = await POST(postRequest({ confirm_name: 'fel namn' }), routeParams())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('FISCAL_YEAR_RESET_CONFIRMATION_MISMATCH')
  })

  it('returns 409 when entries are linked to other records', async () => {
    resetFiscalYearMock.mockResolvedValue({
      ok: false,
      code: 'FISCAL_YEAR_RESET_LINKED_ENTRIES',
    })

    const response = await POST(postRequest(), routeParams())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('FISCAL_YEAR_RESET_LINKED_ENTRIES')
  })

  it('returns 404 when the period does not exist', async () => {
    resetFiscalYearMock.mockResolvedValue({
      ok: false,
      code: 'FISCAL_YEAR_RESET_NOT_FOUND',
    })

    const response = await POST(postRequest(), routeParams())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('FISCAL_YEAR_RESET_NOT_FOUND')
  })
})
