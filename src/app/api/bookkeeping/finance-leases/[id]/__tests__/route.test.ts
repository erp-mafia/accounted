import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/bokslut/leasing/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/leasing/register')>()),
  getFinanceLease: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { FinanceLeaseError, getFinanceLease } from '@/lib/bokslut/leasing/register'
import { GET } from '../route'

const supabase = {}
const get = (id = 'lease-1') =>
  GET(createMockRequest(`/api/bookkeeping/finance-leases/${id}`), { params: Promise.resolve({ id }) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_FINANCE_LEASE_ENABLED', 'true')
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/bookkeeping/finance-leases/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await get()).status).toBe(401)
  })

  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_LEASE_ENABLED', '')
    expect((await get()).status).toBe(503)
    expect(getFinanceLease).not.toHaveBeenCalled()
  })

  it('returns 404 for a lease outside the company', async () => {
    vi.mocked(getFinanceLease).mockRejectedValue(new FinanceLeaseError('FINANCE_LEASE_NOT_FOUND'))
    const res = await get('other')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('FINANCE_LEASE_NOT_FOUND')
    expect(getFinanceLease).toHaveBeenCalledWith(supabase, 'company-1', 'other')
  })

  it('answers the lease and its schedule', async () => {
    vi.mocked(getFinanceLease).mockResolvedValue({
      row: { id: 'lease-1', name: 'Grävmaskin' },
      schedule: {
        presentValue: 1000,
        initialLiability: 1000,
        initialAsset: 1000,
        ratePerPeriod: 0.1,
        depreciationMonths: 36,
        rows: [{ index: 0, date: '2026-12-31', payment: 400, interest: 100, amortisation: 300, liability: 700, accrualFromMonth: 0, accrualToMonth: 12 }],
      },
    } as never)
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.lease.id).toBe('lease-1')
    expect(data.schedule).toEqual({
      initial_asset: 1000,
      initial_liability: 1000,
      depreciation_months: 36,
      rows: [{ index: 0, date: '2026-12-31', payment: 400, interest: 100, amortisation: 300, liability: 700 }],
    })
  })
})
