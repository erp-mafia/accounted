import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/stock-count/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/stock-count/register')>()),
  listStockCounts: vi.fn(),
  createStockCount: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { createStockCount, listStockCounts } from '@/lib/bokslut/stock-count/register'
import { StockCountError } from '@/lib/bokslut/stock-count/errors'
import { GET, POST } from '../route'

const supabase = {}
const ctx = { params: Promise.resolve({}) } as never
const PERIOD_ID = '3f6c2a1e-8b4d-4c2e-9a71-5d0e6b7c8a90'
const body = {
  fiscal_period_id: PERIOD_ID,
  count_date: '2026-12-31',
  rows: [{ description: 'Kaffe', quantity: 10, unit_cost: 100 }],
}

const post = (payload: unknown) => POST(createMockRequest('/api/bookkeeping/inventory-counts', { method: 'POST', body: payload }), ctx)
const get = (query = '') => GET(createMockRequest(`/api/bookkeeping/inventory-counts${query}`), ctx)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BOLAGET_COMPANY_IDS', 'company-1')
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

describe('GET /api/bookkeeping/inventory-counts', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await get()).status).toBe(401)
    expect(listStockCounts).not.toHaveBeenCalled()
  })

  it('is closed for a company outside BOLAGET_COMPANY_IDS', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'another-company')
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('STOCK_COUNT_DISABLED')
  })

  it('returns 400 for a malformed fiscal year id', async () => {
    expect((await get('?fiscal_period_id=nope')).status).toBe(400)
  })

  it('lists the counts of one fiscal year', async () => {
    vi.mocked(listStockCounts).mockResolvedValue([{ id: 'count-1', total_value: 900, row_count: 1 }] as never)
    const res = await get(`?fiscal_period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data.counts).toHaveLength(1)
    expect(listStockCounts).toHaveBeenCalledWith(supabase, 'company-1', { fiscalPeriodId: PERIOD_ID })
  })
})

describe('POST /api/bookkeeping/inventory-counts', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await post(body)).status).toBe(401)
    expect(createStockCount).not.toHaveBeenCalled()
  })

  it('returns 400 for a negative quantity, a write-down over 100 % or a missing description', async () => {
    expect((await post({ ...body, rows: [{ description: 'X', quantity: -1, unit_cost: 1 }] })).status).toBe(400)
    expect((await post({ ...body, rows: [{ description: 'X', quantity: 1, unit_cost: 1, write_down_percent: 120 }] })).status).toBe(400)
    expect((await post({ ...body, rows: [{ description: '', quantity: 1, unit_cost: 1 }] })).status).toBe(400)
    expect(createStockCount).not.toHaveBeenCalled()
  })

  it('answers the roll-forward refusal in Swedish', async () => {
    vi.mocked(createStockCount).mockRejectedValue(new StockCountError('STOCK_COUNT_ROLL_FORWARD_REQUIRED'))
    const res = await post({ ...body, count_date: '2027-01-04' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('STOCK_COUNT_ROLL_FORWARD_REQUIRED')
    expect(json.error.message).toMatch(/balansdagen/)
  })

  it('makes the draft', async () => {
    vi.mocked(createStockCount).mockResolvedValue({ id: 'count-1', status: 'draft' } as never)
    const res = await post(body)
    expect(res.status).toBe(201)
    expect((await res.json()).data.id).toBe('count-1')
    expect(createStockCount).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', expect.objectContaining({ fiscal_period_id: PERIOD_ID }))
  })
})
