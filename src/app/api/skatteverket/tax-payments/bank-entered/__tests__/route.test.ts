import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } =
  createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

const ID_1 = '11111111-1111-4111-8111-111111111111'
const ID_2 = '22222222-2222-4222-8222-222222222222'
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: 'upcoming',
  belopp_skatteverket: -5000,
  bank_entered_at: null,
  ...overrides,
})

describe('POST /api/skatteverket/tax-payments/bank-entered', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: mockSupabase,
      error: null,
    })
  })

  function post(body: unknown) {
    return POST(
      createMockRequest('/api/skatteverket/tax-payments/bank-entered', {
        method: 'POST',
        body,
      }),
      createMockRouteParams({}),
    )
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await post({ transaction_ids: [ID_1], entered: true })).status).toBe(401)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid body', async () => {
    expect((await post({ transaction_ids: ['not-a-uuid'], entered: 'yes' })).status).toBe(400)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when a selected row is missing', async () => {
    enqueue({ data: [row(ID_1)], error: null })
    const response = await post({ transaction_ids: [ID_1, ID_2], entered: true })
    expect(response.status).toBe(404)
    expect(findCalls('skattekonto_transactions', 'eq')).toContainEqual([
      'company_id',
      'company-1',
    ])
    expect(findCall('skattekonto_transactions', 'update')).toBeUndefined()
  })

  it('marks selected upcoming debits without changing their status or amount', async () => {
    enqueue({ data: [row(ID_1), row(ID_2)], error: null })
    enqueue({
      data: [
        row(ID_1, { bank_entered_at: '2026-09-23T08:00:00.000Z' }),
        row(ID_2, { bank_entered_at: '2026-09-23T08:00:00.000Z' }),
      ],
      error: null,
    })

    const response = await post({ transaction_ids: [ID_1, ID_2], entered: true })
    const { status, body } = await parseJsonResponse<{
      data: { rows: Array<{ id: string; bank_entered_at: string | null }> }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.rows).toHaveLength(2)
    const payload = findCall('skattekonto_transactions', 'update')?.[0] as Record<string, unknown>
    expect(Object.keys(payload)).toEqual(['bank_entered_at'])
    expect(payload.bank_entered_at).toEqual(expect.any(String))
    expect(findCalls('skattekonto_transactions', 'eq')).toContainEqual(['status', 'upcoming'])
    expect(findCall('skattekonto_transactions', 'lt')).toEqual(['belopp_skatteverket', 0])
  })

  it('keeps the first timestamp when the mark already exists', async () => {
    enqueue({
      data: [row(ID_1, { bank_entered_at: '2026-09-22T08:00:00.000Z' })],
      error: null,
    })
    const response = await post({ transaction_ids: [ID_1], entered: true })
    const { body } = await parseJsonResponse<{
      data: { rows: Array<{ bank_entered_at: string | null }> }
    }>(response)
    expect(response.status).toBe(200)
    expect(body.data.rows[0].bank_entered_at).toBe('2026-09-22T08:00:00.000Z')
    expect(findCall('skattekonto_transactions', 'update')).toBeUndefined()
  })

  it('clears a mark', async () => {
    enqueue({
      data: [row(ID_1, { bank_entered_at: '2026-09-22T08:00:00.000Z' })],
      error: null,
    })
    enqueue({ data: [row(ID_1)], error: null })
    const response = await post({ transaction_ids: [ID_1], entered: false })
    expect(response.status).toBe(200)
    expect(findCall('skattekonto_transactions', 'update')?.[0]).toEqual({
      bank_entered_at: null,
    })
  })

  it('refuses credits and booked rows', async () => {
    enqueue({ data: [row(ID_1, { status: 'booked', belopp_skatteverket: 5000 })], error: null })
    const response = await post({ transaction_ids: [ID_1], entered: true })
    expect(response.status).toBe(400)
    expect(findCall('skattekonto_transactions', 'update')).toBeUndefined()
  })
})
