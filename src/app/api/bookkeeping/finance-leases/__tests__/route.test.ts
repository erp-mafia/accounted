import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/leasing/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/leasing/register')>()),
  listFinanceLeases: vi.fn(),
  financeLeaseCapitalisationChosen: vi.fn(),
  createFinanceLease: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import {
  createFinanceLease,
  financeLeaseCapitalisationChosen,
  listFinanceLeases,
  type FinanceLeaseRow,
} from '@/lib/bokslut/leasing/register'
import { GET, POST } from '../route'

const supabase = {}
const ctx = { params: Promise.resolve({}) } as never

const body = {
  name: 'Grävmaskin',
  start_date: '2026-01-01',
  fair_value: 100_000,
  payment: 40_000,
  number_of_payments: 3,
  periods_per_year: 1,
  payments_in_advance: false,
  annual_rate_percent: 10,
  useful_life_months: 60,
  asset_account: '1227',
  accumulated_depreciation_account: '1229',
  liability_account: '2399',
  lease_cost_account: '5220',
}

const row: FinanceLeaseRow = {
  ...body,
  id: 'lease-1',
  company_id: 'company-1',
  guaranteed_residual: 0,
  direct_costs: 0,
  ownership_transfers: false,
  interest_account: '8419',
  accrued_interest_account: '2960',
  depreciation_account: '7836',
  direct_cost_account: null,
  initial_entry_id: null,
}

const post = (payload: unknown) =>
  POST(createMockRequest('/api/bookkeeping/finance-leases', { method: 'POST', body: payload }), ctx)
const get = () => GET(createMockRequest('/api/bookkeeping/finance-leases'), ctx)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_FINANCE_LEASE_ENABLED', 'true')
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/bookkeeping/finance-leases', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await get()).status).toBe(401)
    expect(listFinanceLeases).not.toHaveBeenCalled()
  })

  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_LEASE_ENABLED', '')
    const res = await get()
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('FINANCE_LEASE_DISABLED')
  })

  it('lists the leases with their recognised amounts and the opt-in', async () => {
    vi.mocked(listFinanceLeases).mockResolvedValue([row])
    vi.mocked(financeLeaseCapitalisationChosen).mockResolvedValue(true)
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.capitalisation_chosen).toBe(true)
    expect(data.leases).toHaveLength(1)
    expect(data.leases[0]).toMatchObject({ id: 'lease-1', initial_asset: 99_474.08, initial_liability: 99_474.08 })
    expect(listFinanceLeases).toHaveBeenCalledWith(supabase, 'company-1')
  })
})

describe('POST /api/bookkeeping/finance-leases', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await post(body)).status).toBe(401)
    expect(createFinanceLease).not.toHaveBeenCalled()
  })

  it('returns 400 for a start mid-month, a numeric account or a direct cost without its account', async () => {
    expect((await post({ ...body, start_date: '2026-01-15' })).status).toBe(400)
    expect((await post({ ...body, asset_account: 1227 })).status).toBe(400)
    expect((await post({ ...body, direct_costs: 500 })).status).toBe(400)
    expect(createFinanceLease).not.toHaveBeenCalled()
  })

  it('registers the lease with the default interest, accrual and depreciation accounts', async () => {
    vi.mocked(createFinanceLease).mockResolvedValue(row)
    const res = await post(body)
    expect(res.status).toBe(201)
    expect((await res.json()).data.id).toBe('lease-1')
    expect(createFinanceLease).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({
        interest_account: '8419',
        accrued_interest_account: '2960',
        depreciation_account: '7836',
        direct_cost_account: null,
        guaranteed_residual: 0,
      }),
    )
  })
})
