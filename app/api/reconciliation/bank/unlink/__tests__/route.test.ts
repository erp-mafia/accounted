/**
 * Tests for POST /api/reconciliation/bank/unlink.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies plus the unlinkReconciliation service.
 * Covers: 401, 403 viewer, validation (400), service failure (400), and the
 * happy path.
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

const unlinkMock = vi.fn()
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  unlinkReconciliation: (...args: unknown[]) => unlinkMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }
const TX_ID = '44444444-4444-4444-8444-444444444444'

describe('POST /api/reconciliation/bank/unlink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    unlinkMock.mockResolvedValue({ success: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/unlink', {
      method: 'POST',
      body: { transaction_id: TX_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/unlink', {
      method: 'POST',
      body: { transaction_id: TX_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('rejects a non-uuid transaction_id with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/unlink', {
      method: 'POST',
      body: { transaction_id: 'not-a-uuid' },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('surfaces an unlink failure as 400 with the service error', async () => {
    unlinkMock.mockResolvedValue({
      success: false,
      error: 'Cannot unlink a categorization-created entry. Use storno to reverse it instead.',
    })

    const request = createMockRequest('/api/reconciliation/bank/unlink', {
      method: 'POST',
      body: { transaction_id: TX_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('storno')
  })

  it('unlinks the transaction', async () => {
    const request = createMockRequest('/api/reconciliation/bank/unlink', {
      method: 'POST',
      body: { transaction_id: TX_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { success: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(unlinkMock).toHaveBeenCalledWith(supabase, 'company-1', TX_ID, 'user-1')
  })
})
