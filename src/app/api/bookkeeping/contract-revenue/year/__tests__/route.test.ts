import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/pagaende-arbeten/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/pagaende-arbeten/register')>()),
  previewContractRevenueYear: vi.fn(),
  bookContractRevenueYear: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import {
  ContractRevenueError,
  bookContractRevenueYear,
  previewContractRevenueYear,
} from '@/lib/bokslut/pagaende-arbeten/register'
import { GET, POST } from '../route'

const supabase = {}
const PERIOD = '5b0f8a8e-8d2a-4d4f-9a55-0f0b8b8f6a11'
const noParams = { params: Promise.resolve({}) } as never
const get = (query = `?fiscal_period_id=${PERIOD}`) =>
  GET(createMockRequest(`/api/bookkeeping/contract-revenue/year${query}`), noParams)
const post = (body: unknown) =>
  POST(createMockRequest('/api/bookkeeping/contract-revenue/year', { method: 'POST', body }), noParams)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED', 'true')
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/bookkeeping/contract-revenue/year', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await get()).status).toBe(401)
  })

  it('returns 400 without a financial year', async () => {
    expect((await get('')).status).toBe(400)
    expect(previewContractRevenueYear).not.toHaveBeenCalled()
  })

  it('returns 404 for a financial year outside the company', async () => {
    vi.mocked(previewContractRevenueYear).mockRejectedValue(new ContractRevenueError('CONTRACT_REVENUE_NO_PERIOD'))
    expect((await get()).status).toBe(404)
  })

  it('answers what booking the year would do', async () => {
    vi.mocked(previewContractRevenueYear).mockResolvedValue({ balansdag: '2026-12-31', lines: [] } as never)
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.balansdag).toBe('2026-12-31')
    expect(previewContractRevenueYear).toHaveBeenCalledWith(supabase, 'company-1', PERIOD)
  })
})

describe('POST /api/bookkeeping/contract-revenue/year', () => {
  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED', '')
    expect((await post({ fiscal_period_id: PERIOD })).status).toBe(503)
  })

  it('returns 400 for a malformed financial year', async () => {
    expect((await post({ fiscal_period_id: 'x' })).status).toBe(400)
  })

  it('refuses figures stated for another day and open issues', async () => {
    vi.mocked(bookContractRevenueYear).mockRejectedValueOnce(
      new ContractRevenueError('CONTRACT_REVENUE_FIGURES_DATE', { balansdag: '2026-12-31', contracts: ['Ombyggnad'] }),
    )
    const res = await post({ fiscal_period_id: PERIOD })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CONTRACT_REVENUE_FIGURES_DATE')
    vi.mocked(bookContractRevenueYear).mockRejectedValueOnce(new ContractRevenueError('CONTRACT_REVENUE_INCOMPLETE'))
    expect((await post({ fiscal_period_id: PERIOD })).status).toBe(409)
  })

  it('books the year and answers the verifikat, or null when nothing changed', async () => {
    vi.mocked(bookContractRevenueYear).mockResolvedValueOnce({
      result: {} as never,
      entry: { id: 'je-1', voucher_series: 'A', voucher_number: 88 } as never,
    })
    const res = await post({ fiscal_period_id: PERIOD })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ journal_entry_id: 'je-1', voucher_series: 'A', voucher_number: 88 })
    expect(bookContractRevenueYear).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', PERIOD)

    vi.mocked(bookContractRevenueYear).mockResolvedValueOnce({ result: {} as never, entry: null })
    expect((await (await post({ fiscal_period_id: PERIOD })).json()).data).toBeNull()
  })
})
