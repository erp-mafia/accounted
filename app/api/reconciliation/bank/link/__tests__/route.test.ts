/**
 * Tests for POST /api/reconciliation/bank/link.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies plus the manualLink service. Covers:
 * 401, 403 viewer, validation (400), service failure (400), and happy path.
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

const manualLinkMock = vi.fn()
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  manualLink: (...args: unknown[]) => manualLinkMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }
const TX_ID = '11111111-1111-4111-8111-111111111111'
const JE_ID = '22222222-2222-4222-8222-222222222222'

describe('POST /api/reconciliation/bank/link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    manualLinkMock.mockResolvedValue({ success: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('rejects a non-uuid transaction_id with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: 'not-a-uuid', journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
    expect(manualLinkMock).not.toHaveBeenCalled()
  })

  it('surfaces a manualLink failure as 400 with the service error', async () => {
    manualLinkMock.mockResolvedValue({
      success: false,
      error: 'Transaktionen är redan kopplad till en verifikation.',
    })

    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Transaktionen är redan kopplad till en verifikation.')
  })

  it('links the transaction, defaulting the account to 1930', async () => {
    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { success: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(manualLinkMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      TX_ID,
      JE_ID,
      'user-1',
      '1930',
    )
  })
})
