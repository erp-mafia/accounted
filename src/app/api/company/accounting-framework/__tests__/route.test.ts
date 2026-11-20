import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-05-01',
}))

import { GET } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/company/accounting-framework', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/company/accounting-framework'), routeParams)
    expect(res.status).toBe(401)
  })

  it('lists each räkenskapsår with its own framework and picks the year running today', async () => {
    enqueue({
      data: [
        { id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, locked_at: null },
        { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null },
      ],
    }) // fiscal_periods
    enqueue({
      data: [
        { fiscal_period_id: 'fp-2025', framework: 'k2', source: 'company_default', change_reason: null },
        { fiscal_period_id: 'fp-2026', framework: 'k3', source: 'election', change_reason: null },
      ],
    }) // fiscal_period_frameworks
    enqueue({ data: { accounting_framework: 'k3' } }) // companies (list fallback)
    enqueue({ data: { accounting_framework: 'k3' } }) // companies (company default)
    const { status, body } = await parseJsonResponse<{
      data: { years: Array<{ id: string; framework: string }>; current_fiscal_period_id: string; company_framework: string }
    }>(await GET(createMockRequest('/api/company/accounting-framework'), routeParams))
    expect(status).toBe(200)
    expect(body.data.years.map((y) => [y.id, y.framework])).toEqual([
      ['fp-2025', 'k2'],
      ['fp-2026', 'k3'],
    ])
    expect(body.data.current_fiscal_period_id).toBe('fp-2026')
    expect(body.data.company_framework).toBe('k3')
  })
})
