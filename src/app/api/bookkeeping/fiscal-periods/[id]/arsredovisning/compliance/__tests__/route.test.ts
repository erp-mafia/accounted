import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/bokslut/arsredovisning/model', () => ({
  buildCanonicalAnnualReport: vi.fn(),
}))
vi.mock('@/lib/bokslut/arsredovisning/profile-service', () => ({
  upsertAnnualReportProfile: vi.fn(),
}))

import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { upsertAnnualReportProfile } from '@/lib/bokslut/arsredovisning/profile-service'
import { GET, PATCH } from '../route'

const params = { params: Promise.resolve({ id: 'period-1' }) }
const model = {
  report: {
    accounting_framework: 'k2',
    forvaltningsberattelse: {
      proposed_dividend: 0,
      resultatdisposition_amounts: { total: 100 },
    },
  },
  profile: { company_id: 'company-1', fiscal_period_id: 'period-1' },
  disclosures: {},
  eligibility: {
    k2_eligible: true,
    digital_filing_eligible: true,
    size_classification: 'smaller',
    k2_relief_rule: 'eligible',
    issues: [],
    digital_issues: [],
  },
  validation: { stage: 'draft', ok: true, error_count: 0, warning_count: 0, issues: [] },
}

function setup() {
  const mock = createQueuedMockSupabase()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: mock.supabase,
    error: null,
  })
  vi.mocked(buildCanonicalAnnualReport).mockResolvedValue(model as never)
  vi.mocked(upsertAnnualReportProfile).mockResolvedValue(model.profile as never)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('annual report compliance route', () => {
  it('returns 401 without authentication', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(createMockRequest('/x'), params)).status).toBe(401)
  })

  it('returns 400 for an empty patch', async () => {
    setup()
    const response = await PATCH(
      createMockRequest('/x', { method: 'PATCH', body: {} }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for another company period', async () => {
    // GET has no periodExists preflight: the 404 comes from the report
    // builder throwing 'Fiscal period not found' (same company_id filter).
    setup()
    vi.mocked(buildCanonicalAnnualReport).mockRejectedValue(
      new Error('Fiscal period not found'),
    )
    expect((await GET(createMockRequest('/x'), params)).status).toBe(404)
  })

  it('maps unexpected builder failures to the generic error envelope', async () => {
    setup()
    vi.mocked(buildCanonicalAnnualReport).mockRejectedValue(new Error('boom'))
    expect((await GET(createMockRequest('/x'), params)).status).toBe(500)
  })

  it('returns the canonical compliance result', async () => {
    setup()
    const { status, body } = await parseJsonResponse<{ data: typeof model }>(
      await GET(createMockRequest('/x'), params),
    )
    expect(status).toBe(200)
    expect(body.data.validation.ok).toBe(true)
  })

  it('keeps the periodExists preflight on PATCH (404 before any write)', async () => {
    const { enqueue } = setup()
    enqueue({ data: null })
    const response = await PATCH(
      createMockRequest('/x', {
        method: 'PATCH',
        body: { is_public_limited_company: false },
      }),
      params,
    )
    expect(response.status).toBe(404)
    expect(upsertAnnualReportProfile).not.toHaveBeenCalled()
  })

  it('persists legal facts and confirmation timestamps', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'period-1' } })
    const response = await PATCH(
      createMockRequest('/x', {
        method: 'PATCH',
        body: { is_public_limited_company: false, k2_assessment_confirmed: true },
      }),
      params,
    )
    expect(response.status).toBe(200)
    expect(upsertAnnualReportProfile).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'period-1',
      expect.objectContaining({
        is_public_limited_company: false,
        k2_assessment_confirmed_at: expect.any(String),
      }),
    )
  })

  it('records explicit representative roster confirmation', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'period-1' } })
    const response = await PATCH(
      createMockRequest('/x', {
        method: 'PATCH',
        body: { signer_roster_confirmed: true },
      }),
      params,
    )
    expect(response.status).toBe(200)
    expect(upsertAnnualReportProfile).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'period-1',
      expect.objectContaining({ signer_roster_confirmed_at: expect.any(String) }),
    )
  })
})
