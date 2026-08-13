/**
 * Tests for POST /api/reconciliation/bank/confirm-suggestions.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies plus the suggestions service. Covers:
 * 401, 403 viewer, validation (400), and both actions' happy paths.
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

const confirmMock = vi.fn()
const rejectMock = vi.fn()
vi.mock('@/lib/reconciliation/suggestions', () => ({
  confirmJournalEntrySuggestions: (...args: unknown[]) => confirmMock(...args),
  rejectJournalEntrySuggestions: (...args: unknown[]) => rejectMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }
const TX_1 = '11111111-1111-4111-8111-111111111111'
const TX_2 = '22222222-2222-4222-8222-222222222222'

describe('POST /api/reconciliation/bank/confirm-suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    confirmMock.mockResolvedValue({ confirmed: [TX_1], rejected: [], skipped: [] })
    rejectMock.mockResolvedValue({ confirmed: [], rejected: [TX_1], skipped: [] })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/confirm-suggestions', {
      method: 'POST',
      body: { transaction_ids: [TX_1], action: 'confirm' },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/confirm-suggestions', {
      method: 'POST',
      body: { transaction_ids: [TX_1], action: 'confirm' },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('rejects an empty transaction_ids array with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/confirm-suggestions', {
      method: 'POST',
      body: { transaction_ids: [], action: 'confirm' },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown action with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/confirm-suggestions', {
      method: 'POST',
      body: { transaction_ids: [TX_1], action: 'maybe' },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
  })

  it('confirms suggestions and reports skipped pairs in snake_case', async () => {
    confirmMock.mockResolvedValue({
      confirmed: [TX_1],
      rejected: [],
      skipped: [{ transactionId: TX_2, reason: 'voucher_consumed' }],
    })

    const request = createMockRequest('/api/reconciliation/bank/confirm-suggestions', {
      method: 'POST',
      body: { transaction_ids: [TX_1, TX_2], action: 'confirm' },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{
      data: {
        confirmed: string[]
        skipped: Array<{ transaction_id: string; reason: string }>
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.confirmed).toEqual([TX_1])
    expect(body.data.skipped).toEqual([
      { transaction_id: TX_2, reason: 'voucher_consumed', message: undefined },
    ])
    expect(confirmMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', [TX_1, TX_2])
    expect(rejectMock).not.toHaveBeenCalled()
  })

  it('routes action=reject to the reject service', async () => {
    const request = createMockRequest('/api/reconciliation/bank/confirm-suggestions', {
      method: 'POST',
      body: { transaction_ids: [TX_1], action: 'reject' },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { rejected: string[] } }>(response)

    expect(status).toBe(200)
    expect(body.data.rejected).toEqual([TX_1])
    expect(rejectMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', [TX_1])
    expect(confirmMock).not.toHaveBeenCalled()
  })
})
