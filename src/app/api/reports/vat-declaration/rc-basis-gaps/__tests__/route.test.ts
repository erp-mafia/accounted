/**
 * Tests for GET /api/reports/vat-declaration/rc-basis-gaps.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking its
 * auth/company dependencies and findRcBasisGaps(). Covers: 401, missing and
 * invalid params, the happy path, and that fiscal_period_id is forwarded so
 * yearly (helårsmoms) worklists cover the räkenskapsår instead of the
 * calendar year.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const findRcBasisGapsMock = vi.fn()
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...args: unknown[]) => findRcBasisGapsMock(...args),
}))

import { GET } from '../route'

function gapsRequest(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/vat-declaration/rc-basis-gaps', { searchParams })
}

const validParams = { periodType: 'quarterly', year: '2026', period: '2' }

describe('GET /api/reports/vat-declaration/rc-basis-gaps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    findRcBasisGapsMock.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(gapsRequest(validParams), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
    expect(findRcBasisGapsMock).not.toHaveBeenCalled()
  })

  it('returns 400 when period params are missing', async () => {
    const response = await GET(
      gapsRequest({ periodType: 'quarterly' }),
      { params: Promise.resolve({}) },
    )
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(400)
  })

  it('returns 400 for an invalid periodType', async () => {
    const response = await GET(
      gapsRequest({ ...validParams, periodType: 'weekly' }),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VAT_REPORT_INVALID_PERIOD_TYPE')
  })

  it('returns the detected gaps (happy path)', async () => {
    const gap = {
      entryId: 'entry-1',
      voucherNumber: 8,
      voucherSeries: 'A',
      entryDate: '2026-05-20',
      description: 'Greptile Apr-Maj',
      rcOutputAccount: '2614',
      rcOutputAmount: 527.29,
      expectedBasisAmount: 2109.16,
      suggestedBasisAccount: '4535',
      rate: 0.25,
    }
    findRcBasisGapsMock.mockResolvedValue([gap])

    const response = await GET(gapsRequest(validParams), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { gaps: unknown[] } }>(response)

    expect(status).toBe(200)
    expect(body.data.gaps).toEqual([gap])
    expect(findRcBasisGapsMock).toHaveBeenCalledWith(supabase, 'company-1', 'quarterly', 2026, 2, {
      fiscalPeriodId: undefined,
    })
  })

  it('forwards fiscal_period_id for yearly declarations', async () => {
    const response = await GET(
      gapsRequest({ periodType: 'yearly', year: '2026', period: '1', fiscal_period_id: 'fp-1' }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(200)
    expect(findRcBasisGapsMock).toHaveBeenCalledWith(supabase, 'company-1', 'yearly', 2026, 1, {
      fiscalPeriodId: 'fp-1',
    })
  })

  it('maps a lib failure to VAT_REPORT_GENERATION_FAILED', async () => {
    findRcBasisGapsMock.mockRejectedValue(new Error('boom'))

    const response = await GET(gapsRequest(validParams), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBeGreaterThanOrEqual(500)
    expect(body.error.code).toBe('VAT_REPORT_GENERATION_FAILED')
  })
})
