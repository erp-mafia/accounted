import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/pagaende-arbeten/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/pagaende-arbeten/register')>()),
  createContract: vi.fn(),
  updateContract: vi.fn(),
  deleteContract: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import {
  ContractRevenueError,
  createContract,
  deleteContract,
  updateContract,
} from '@/lib/bokslut/pagaende-arbeten/register'
import { POST } from '../route'
import { DELETE, PUT } from '../[id]/route'

const supabase = {}
const body = {
  name: 'Ombyggnad',
  kind: 'fast_pris',
  figures_as_of: '2026-12-31',
  contract_value: 1_000_000,
  expected_total_cost: 800_000,
  costs_to_date: 400_000,
  billed_to_date: 450_000,
}
const idCtx = (id = 'c1') => ({ params: Promise.resolve({ id }) }) as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED', 'true')
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/bookkeeping/contract-revenue/contracts', () => {
  const post = (payload: unknown) =>
    POST(createMockRequest('/api/bookkeeping/contract-revenue/contracts', { method: 'POST', body: payload }), {
      params: Promise.resolve({}),
    } as never)

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await post(body)).status).toBe(401)
  })

  it('returns 400 for a negative amount or a stated grade method without the grade', async () => {
    expect((await post({ ...body, costs_to_date: -1 })).status).toBe(400)
    expect((await post({ ...body, grade_method: 'fysisk' })).status).toBe(400)
    expect(createContract).not.toHaveBeenCalled()
  })

  it('adds the uppdrag with the defaults filled in', async () => {
    vi.mocked(createContract).mockResolvedValue({ id: 'c1' } as never)
    const res = await post(body)
    expect(res.status).toBe(201)
    expect(createContract).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', expect.objectContaining({
      retained_amounts: 0,
      reliable_outcome: true,
      grade_method: 'utgifter',
      stated_grade: null,
    }))
  })
})

describe('PUT and DELETE /api/bookkeeping/contract-revenue/contracts/[id]', () => {
  const put = (payload: unknown, id = 'c1') =>
    PUT(createMockRequest(`/api/bookkeeping/contract-revenue/contracts/${id}`, { method: 'PUT', body: payload }), idCtx(id))
  const del = (id = 'c1') =>
    DELETE(createMockRequest(`/api/bookkeeping/contract-revenue/contracts/${id}`, { method: 'DELETE' }), idCtx(id))

  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED', '')
    expect((await put(body)).status).toBe(503)
    expect((await del()).status).toBe(503)
  })

  it('returns 400 for an incomplete body', async () => {
    expect((await put({ name: 'x' })).status).toBe(400)
  })

  it('returns 404 for an uppdrag outside the company', async () => {
    vi.mocked(updateContract).mockRejectedValue(new ContractRevenueError('CONTRACT_REVENUE_NOT_FOUND'))
    vi.mocked(deleteContract).mockRejectedValue(new ContractRevenueError('CONTRACT_REVENUE_NOT_FOUND'))
    expect((await put(body, 'other')).status).toBe(404)
    expect((await del('other')).status).toBe(404)
  })

  it('states the figures anew and removes an uppdrag', async () => {
    vi.mocked(updateContract).mockResolvedValue({ id: 'c1' } as never)
    vi.mocked(deleteContract).mockResolvedValue()
    expect((await put(body)).status).toBe(200)
    expect(updateContract).toHaveBeenCalledWith(supabase, 'company-1', 'c1', expect.objectContaining({ name: 'Ombyggnad' }))
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ id: 'c1' })
  })
})
