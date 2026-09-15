import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { BrfError } from '@/lib/company/brf-tax-profile'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/company/brf-tax-profile', async () => {
  const actual = await vi.importActual<typeof import('@/lib/company/brf-tax-profile')>('@/lib/company/brf-tax-profile')
  return {
    ...actual,
    requireBrfForm: vi.fn(),
    getPropertyFacts: vi.fn(),
  }
})

import { getPropertyFacts, requireBrfForm } from '@/lib/company/brf-tax-profile'
import { GET } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  vi.mocked(requireBrfForm).mockResolvedValue(undefined)
})

describe('GET /api/brf/fastighetsavgift', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/brf/fastighetsavgift?fiscal_year=2026'), routeParams)
    expect(res.status).toBe(401)
  })

  it('refuses a company that is not a bostadsrättsförening with 409', async () => {
    vi.mocked(requireBrfForm).mockRejectedValue(new BrfError('BRF_FORM_REQUIRED'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/brf/fastighetsavgift?fiscal_year=2026'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('BRF_FORM_REQUIRED')
  })

  it('returns 400 without a calendar year', async () => {
    const missing = await GET(createMockRequest('/api/brf/fastighetsavgift'), routeParams)
    expect(missing.status).toBe(400)
    const bad = await GET(createMockRequest('/api/brf/fastighetsavgift?fiscal_year=20x'), routeParams)
    expect(bad.status).toBe(400)
  })

  it('computes the fee from the stored facts and names the template and INK2 boxes', async () => {
    vi.mocked(getPropertyFacts).mockResolvedValue({
      antal_bostadslagenheter: 40,
      taxeringsvarde_bostader: '120000000.00',
      taxeringsvarde_lokaler: '30000000.00',
      vardear: 1998,
    } as never)
    const { status, body } = await parseJsonResponse<{ data: { total: number; bostader: { amount: number; ink2Field: string }; lokaler: { amount: number }; bookingTemplateId: string; warnings: string[] } }>(
      await GET(createMockRequest('/api/brf/fastighetsavgift?fiscal_year=2026'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.bostader.amount).toBe(71_360)
    expect(body.data.bostader.ink2Field).toBe('1.9 hel avgift')
    expect(body.data.lokaler.amount).toBe(300_000)
    expect(body.data.total).toBe(371_360)
    expect(body.data.bookingTemplateId).toBe('brf_fastighetsavgift')
    expect(body.data.warnings).toEqual([])
  })

  it('answers with null amounts and a warning before facts exist', async () => {
    vi.mocked(getPropertyFacts).mockResolvedValue(null)
    const { status, body } = await parseJsonResponse<{ data: { total: number | null; warnings: string[] } }>(
      await GET(createMockRequest('/api/brf/fastighetsavgift?fiscal_year=2026'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.total).toBeNull()
    expect(body.data.warnings[0]).toContain('Fastighetsuppgifter saknas')
  })
})
