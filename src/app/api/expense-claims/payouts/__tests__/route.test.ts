/**
 * Contract tests for /api/expense-claims/payouts (GET list, POST create).
 * The service is mocked; pins auth, validation and code → status mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const createPayoutMock = vi.fn()
const listPayoutsMock = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  createPayoutBatch: (...args: unknown[]) => createPayoutMock(...args),
  listPayoutBatches: (...args: unknown[]) => listPayoutsMock(...args),
}))

import { GET, POST } from '../route'

function post(body: unknown) {
  return createMockRequest('/api/expense-claims/payouts', { method: 'POST', body })
}

const validPayout = {
  claim_ids: ['5a0a4c86-0000-4000-8000-000000000001'],
  payout_date: '2026-09-05',
  cash_account: '1935',
}

describe('/api/expense-claims/payouts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    listPayoutsMock.mockResolvedValue([])
    createPayoutMock.mockResolvedValue({
      ok: true,
      batch_id: 'batch-1',
      journal_entry_id: 'je-1',
      total_sek: 500,
      claim_count: 1,
    })
  })

  it('POST returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(post(validPayout), {} as never)
    expect(response.status).toBe(401)
  })

  it('POST creates a payout (201)', async () => {
    const response = await POST(post(validPayout), {} as never)
    const { status, body } = await parseJsonResponse<{ data: { batch_id: string } }>(response)
    expect(status).toBe(201)
    expect(body.data.batch_id).toBe('batch-1')
  })

  it('POST rejects a non-19xx cash account', async () => {
    const response = await POST(post({ ...validPayout, cash_account: '2893' }), {} as never)
    expect(response.status).toBe(400)
    expect(createPayoutMock).not.toHaveBeenCalled()
  })

  it.each([
    ['MIXED_CLAIMANTS', 400],
    ['ALREADY_PAID', 409],
    ['CLAIMS_NOT_FOUND', 404],
    ['BATCH_INSERT_FAILED', 500],
  ] as const)('POST maps service code %s to %d', async (code, expected) => {
    createPayoutMock.mockResolvedValue({ ok: false, code })
    const response = await POST(post(validPayout), {} as never)
    expect(response.status).toBe(expected)
  })

  it('GET lists payout batches', async () => {
    listPayoutsMock.mockResolvedValue([{ id: 'batch-1' }])
    const response = await GET(createMockRequest('/api/expense-claims/payouts'), {} as never)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })
})
