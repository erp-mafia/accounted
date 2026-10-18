/**
 * Tests for GET/POST /api/bookkeeping/fiscal-periods/[id]/reopen (crm#1290).
 *
 * Through the real withRouteContext wrapper, with its auth/company/write
 * dependencies and the fiscal-year-reopen service mocked: 401, 403 for a
 * viewer, validation 400, 404, the preview passthrough, the happy path, and
 * the refusal envelopes (ineligible with blockers, confirmation, forbidden,
 * incomplete).
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
const reopenMock = vi.fn()
vi.mock('@/lib/core/bookkeeping/fiscal-year-reopen', () => ({
  FISCAL_YEAR_REOPEN_REGISTRY_KEYS: ['financialReports', 'financialReportsComplete'],
  getFiscalYearReopenEligibility: (...args: unknown[]) => getEligibilityMock(...args),
  reopenClosedFiscalYear: (...args: unknown[]) => reopenMock(...args),
}))

const ensureTicSnapshotMock = vi.fn()
vi.mock('@/lib/agent/composer/tic-fetch', () => ({
  ensureTicSnapshot: (...args: unknown[]) => ensureTicSnapshotMock(...args),
}))

import { GET, POST } from '../route'

const routeParams = () => createMockRouteParams({ id: 'period-1' })
const URL_PATH = '/api/bookkeeping/fiscal-periods/period-1/reopen'

const ELIGIBILITY = {
  eligible: true,
  blockers: [],
  resume: false,
  period: { id: 'period-1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', closing_entry_id: 'je-1' },
  next_period: { id: 'period-2', name: '2026' },
  entries: [],
  annual_report: { versions_to_supersede: 1, pending_signatures: 1, agm_date: null },
  registry: { fetched_at: '2026-10-18T00:00:00Z', reports: 0 },
}

function signedIn() {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
}

describe('GET /api/bookkeeping/fiscal-periods/[id]/reopen', () => {
  beforeEach(signedIn)

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest(URL_PATH), routeParams())

    expect(response.status).toBe(401)
    expect(getEligibilityMock).not.toHaveBeenCalled()
  })

  it('returns the preview', async () => {
    getEligibilityMock.mockResolvedValue({ ok: true, eligibility: ELIGIBILITY })

    const { status, body } = await parseJsonResponse<{ data: typeof ELIGIBILITY }>(
      await GET(createMockRequest(URL_PATH), routeParams()),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual(ELIGIBILITY)
    expect(getEligibilityMock).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      refreshRegistry: expect.any(Function),
    })
  })

  it('hands the service a registry refresh that re-fetches TIC for the gate\'s keys', async () => {
    getEligibilityMock.mockResolvedValue({ ok: true, eligibility: ELIGIBILITY })
    await GET(createMockRequest(URL_PATH), routeParams())

    const deps = getEligibilityMock.mock.calls[0][3] as { refreshRegistry: () => Promise<unknown> }
    await deps.refreshRegistry()
    expect(ensureTicSnapshotMock).toHaveBeenCalledWith({
      supabase,
      companyId: 'company-1',
      timeoutMs: 10_000,
      requireKeys: ['financialReports', 'financialReportsComplete'],
    })
  })

  it('returns 404 and 403 from the service codes', async () => {
    for (const [code, httpStatus] of [
      ['FISCAL_YEAR_REOPEN_NOT_FOUND', 404],
      ['FISCAL_YEAR_REOPEN_FORBIDDEN', 403],
      ['FISCAL_YEAR_REOPEN_FAILED', 500],
    ] as const) {
      getEligibilityMock.mockResolvedValue({ ok: false, code })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
        await GET(createMockRequest(URL_PATH), routeParams()),
      )
      expect(status).toBe(httpStatus)
      expect(body.error.code).toBe(code)
    }
  })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/reopen', () => {
  beforeEach(signedIn)

  const postRequest = (body?: unknown) =>
    createMockRequest(URL_PATH, {
      method: 'POST',
      body: body ?? { confirm_name: '2025', confirm_annual_report_not_adopted: true },
    })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(postRequest(), routeParams())

    expect(response.status).toBe(401)
    expect(reopenMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(postRequest(), routeParams())

    expect(response.status).toBe(403)
    expect(reopenMock).not.toHaveBeenCalled()
  })

  it('returns 400 without the year name or the statement', async () => {
    for (const body of [
      { confirm_annual_report_not_adopted: true },
      { confirm_name: '2025' },
      { confirm_name: '2025', confirm_annual_report_not_adopted: 'yes' },
    ]) {
      const response = await POST(postRequest(body), routeParams())
      expect(response.status).toBe(400)
    }
    expect(reopenMock).not.toHaveBeenCalled()
  })

  it('reopens and answers what was reversed', async () => {
    reopenMock.mockResolvedValue({
      ok: true,
      periodName: '2025',
      resumed: false,
      reversed: [
        { id: 'je-1', kind: 'closing_entry', voucher_series: 'A', voucher_number: 43, entry_date: '2025-12-31', fiscal_period_id: 'period-1' },
      ],
      supersededVersions: 1,
    })

    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await POST(postRequest(), routeParams()),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({
      periodName: '2025',
      resumed: false,
      reversed: [{ id: 'je-1', kind: 'closing_entry', voucher: 'A43' }],
      supersededVersions: 1,
    })
    expect(reopenMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      'user-1',
      { confirmName: '2025', confirmNotAdopted: true },
      { refreshRegistry: expect.any(Function) },
    )
  })

  it('returns 409 with the blockers when the year is ineligible', async () => {
    reopenMock.mockResolvedValue({
      ok: false,
      code: 'FISCAL_YEAR_REOPEN_INELIGIBLE',
      blockers: [{ code: 'annual_report_registered' }],
    })

    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { blockers?: Array<{ code: string }> } }
    }>(await POST(postRequest(), routeParams()))

    expect(status).toBe(409)
    expect(body.error.code).toBe('FISCAL_YEAR_REOPEN_INELIGIBLE')
    expect(body.error.details?.blockers).toEqual([{ code: 'annual_report_registered' }])
  })

  it('maps the confirmation, forbidden and incomplete refusals', async () => {
    for (const [code, httpStatus] of [
      ['FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED', 400],
      ['FISCAL_YEAR_REOPEN_CONFIRMATION_MISMATCH', 400],
      ['FISCAL_YEAR_REOPEN_FORBIDDEN', 403],
      ['FISCAL_YEAR_REOPEN_INCOMPLETE', 500],
    ] as const) {
      reopenMock.mockResolvedValue({ ok: false, code, ...(code === 'FISCAL_YEAR_REOPEN_INCOMPLETE' ? { stoppedAt: 'A43' } : {}) })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
        await POST(postRequest(), routeParams()),
      )
      expect(status).toBe(httpStatus)
      expect(body.error.code).toBe(code)
    }
  })
})
