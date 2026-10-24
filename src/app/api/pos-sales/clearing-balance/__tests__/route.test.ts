import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The rules are unit-tested in lib/pos-sales/__tests__/clearing-balance.test.ts;
// here the route's envelope: auth, validation, the outcome mapped.
const { getPosClearingBalance } = vi.hoisted(() => ({ getPosClearingBalance: vi.fn() }))
vi.mock('@/lib/pos-sales/clearing-balance', () => ({ getPosClearingBalance }))

import { GET } from '../route'

const NO_PARAMS = { params: Promise.resolve({}) }

interface Envelope {
  data?: Record<string, unknown>
  error?: { code: string }
}

const get = (query = '') => GET(createMockRequest(`/api/pos-sales/clearing-balance${query}`, { method: 'GET' }), NO_PARAMS)

describe('GET /api/pos-sales/clearing-balance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  })

  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await get()).status).toBe(401)
    expect(getPosClearingBalance).not.toHaveBeenCalled()
  })

  it('answers 400 for a date that does not exist', async () => {
    expect((await get('?as_of=2026-13-45')).status).toBe(400)
    expect(getPosClearingBalance).not.toHaveBeenCalled()
  })

  it('answers 404 for a company without a till', async () => {
    getPosClearingBalance.mockResolvedValue({ ok: false, code: 'POS_CONNECTION_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<Envelope>(await get())
    expect(status).toBe(404)
    expect(body.error?.code).toBe('POS_CONNECTION_NOT_FOUND')
  })

  it('answers the balance for the active company and the date asked', async () => {
    const data = { as_of: '2026-09-30', accounts: ['1686'], ledger_balance: 11_500, fiscal_period_id: 'fy', unbooked_days: 2, unbooked_amount: 23_001 }
    getPosClearingBalance.mockResolvedValue({ ok: true, data })
    const { status, body } = await parseJsonResponse<Envelope>(await get('?as_of=2026-09-30'))
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    const [ctx, input] = getPosClearingBalance.mock.calls[0] as [{ companyId: string; userId: string }, unknown]
    expect(ctx).toMatchObject({ companyId: 'company-1', userId: 'user-1' })
    expect(input).toEqual({ as_of: '2026-09-30' })
  })
})
