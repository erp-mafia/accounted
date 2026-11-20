import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/pagaende-arbeten/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/pagaende-arbeten/register')>()),
  getContractRevenueSettings: vi.fn(),
  listContracts: vi.fn(),
  saveContractRevenueSettings: vi.fn(),
  deleteContractRevenueSettings: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import {
  ContractRevenueError,
  deleteContractRevenueSettings,
  getContractRevenueSettings,
  listContracts,
  saveContractRevenueSettings,
} from '@/lib/bokslut/pagaende-arbeten/register'
import { DELETE, GET, PUT } from '../route'

const supabase = {}
const ctx = { params: Promise.resolve({}) } as never
const get = () => GET(createMockRequest('/api/bookkeeping/contract-revenue'), ctx)
const put = (body: unknown) => PUT(createMockRequest('/api/bookkeeping/contract-revenue', { method: 'PUT', body }), ctx)
const del = () => DELETE(createMockRequest('/api/bookkeeping/contract-revenue', { method: 'DELETE' }), ctx)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED', 'true')
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const unauthenticated = () =>
  vi.mocked(requireAuth).mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  } as never)

describe('GET /api/bookkeeping/contract-revenue', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await get()).status).toBe(401)
  })

  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED', '')
    const res = await get()
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('CONTRACT_REVENUE_DISABLED')
  })

  it('answers the settings and the uppdrag', async () => {
    vi.mocked(getContractRevenueSettings).mockResolvedValue({ method: 'successiv', revenue_account: '3090' })
    vi.mocked(listContracts).mockResolvedValue([{ id: 'c1', name: 'Ombyggnad' }] as never)
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      settings: { method: 'successiv', revenue_account: '3090' },
      contracts: [{ id: 'c1', name: 'Ombyggnad' }],
    })
    expect(listContracts).toHaveBeenCalledWith(supabase, 'company-1')
  })
})

describe('PUT /api/bookkeeping/contract-revenue', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await put({ method: 'successiv', revenue_account: '3090' })).status).toBe(401)
    expect(saveContractRevenueSettings).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown method, a numeric account or one outside nettoomsättning', async () => {
    expect((await put({ method: 'other', revenue_account: '3090' })).status).toBe(400)
    expect((await put({ method: 'successiv', revenue_account: 3090 })).status).toBe(400)
    expect((await put({ method: 'successiv', revenue_account: '3910' })).status).toBe(400)
    expect(saveContractRevenueSettings).not.toHaveBeenCalled()
  })

  it('refuses an account a momsruta reads', async () => {
    vi.mocked(saveContractRevenueSettings).mockRejectedValue(
      new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_VAT', { account: '3001' }),
    )
    const res = await put({ method: 'successiv', revenue_account: '3001' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CONTRACT_REVENUE_ACCOUNT_VAT')
  })

  it('refuses an account with posted lines for something else', async () => {
    vi.mocked(saveContractRevenueSettings).mockRejectedValue(
      new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_IN_USE', { account: '3090' }),
    )
    const res = await put({ method: 'successiv', revenue_account: '3090' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CONTRACT_REVENUE_ACCOUNT_IN_USE')
  })

  it('returns 404 for an account missing from the chart', async () => {
    vi.mocked(saveContractRevenueSettings).mockRejectedValue(new ContractRevenueError('CONTRACT_REVENUE_ACCOUNT_MISSING'))
    expect((await put({ method: 'successiv', revenue_account: '3090' })).status).toBe(404)
  })

  it('saves the method and the account', async () => {
    vi.mocked(saveContractRevenueSettings).mockResolvedValue({ method: 'fardigstallande', revenue_account: '3090' })
    const res = await put({ method: 'fardigstallande', revenue_account: '3090' })
    expect(res.status).toBe(200)
    expect(saveContractRevenueSettings).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      method: 'fardigstallande',
      revenue_account: '3090',
    })
  })
})

describe('DELETE /api/bookkeeping/contract-revenue', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await del()).status).toBe(401)
    expect(deleteContractRevenueSettings).not.toHaveBeenCalled()
  })

  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED', '')
    expect((await del()).status).toBe(503)
    expect(deleteContractRevenueSettings).not.toHaveBeenCalled()
  })

  it('refuses a reader', async () => {
    vi.mocked(requireWritePermission).mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    expect((await del()).status).toBe(403)
    expect(deleteContractRevenueSettings).not.toHaveBeenCalled()
  })

  it('returns 409 when nothing is chosen', async () => {
    vi.mocked(deleteContractRevenueSettings).mockRejectedValue(new ContractRevenueError('CONTRACT_REVENUE_NOT_CONFIGURED'))
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CONTRACT_REVENUE_NOT_CONFIGURED')
  })

  it('removes the method and the account', async () => {
    vi.mocked(deleteContractRevenueSettings).mockResolvedValue()
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toBeNull()
    expect(deleteContractRevenueSettings).toHaveBeenCalledWith(supabase, 'company-1')
  })
})
