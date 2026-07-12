import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams } from '@/tests/helpers'

// The route is wrapped in withRouteContext and gated with requireWrite (it
// persists payment_file_generated_at). The XML generator, net-payout helper and
// branding are stubbed so we can exercise auth + the happy path.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/salary/payment/pain001-generator', () => ({
  generatePain001: vi.fn(() => '<Document/>'),
}))
vi.mock('@/lib/salary/payment/effective-net', () => ({
  effectiveNetPayout: vi.fn(() => 20000),
}))
vi.mock('@/lib/branding/service', () => ({
  getBranding: vi.fn(() => ({ appName: 'gnubok' })),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany }
}

describe('GET /api/salary/runs/[id]/payment/pain001', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('generates a pain.001 file for an approved run', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } }, // companies
      { data: { company_name: 'Bolaget AB', iban: 'SE4550000000058398257466', bic: 'NDEASESS' } }, // settings
      {
        data: [
          {
            employee: { first_name: 'Anna', last_name: 'A', clearing_number: '1234', bank_account_number: '567890' },
          },
        ],
      }, // salary_run_employees
      { data: null }, // salary_runs update
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/pain001'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toContain('pain001_lon_2026-03.xml')
  })
})
