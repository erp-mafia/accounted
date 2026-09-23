/**
 * Tests for POST /api/reconciliation/bank/mark-opening-balance.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, 403 viewer, validation (400), the RPC error
 * translation to Swedish, and the happy path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }
const JE_ID = '33333333-3333-4333-8333-333333333333'

describe('POST /api/reconciliation/bank/mark-opening-balance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/mark-opening-balance', {
      method: 'POST',
      body: { journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/mark-opening-balance', {
      method: 'POST',
      body: { journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('rejects a non-uuid journal_entry_id with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/mark-opening-balance', {
      method: 'POST',
      body: { journal_entry_id: 'nope' },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
  })

  it('translates a locked-period RPC error to Swedish', async () => {
    enqueue({ error: { message: 'Cannot modify entries in a locked fiscal period' } })

    const request = createMockRequest('/api/reconciliation/bank/mark-opening-balance', {
      method: 'POST',
      body: { journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Perioden är låst. Lås upp perioden innan du ändrar verifikationen.')
  })

  it('marks the entry as opening balance via the RPC', async () => {
    enqueue({ data: { updated: true } })

    const request = createMockRequest('/api/reconciliation/bank/mark-opening-balance', {
      method: 'POST',
      body: { journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { updated: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('mark_entry_as_opening_balance', {
      p_company_id: 'company-1',
      p_entry_id: JE_ID,
    })
  })
})
