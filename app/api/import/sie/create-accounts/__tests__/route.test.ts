/**
 * Tests for POST /api/import/sie/create-accounts.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, 403 viewer, empty-body validation (400), and the
 * happy-path batch upsert.
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

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

describe('POST /api/import/sie/create-accounts', () => {
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

    const request = createMockRequest('/api/import/sie/create-accounts', {
      method: 'POST',
      body: { accounts: [{ number: '1930', name: 'Företagskonto' }] },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/import/sie/create-accounts', {
      method: 'POST',
      body: { accounts: [{ number: '1930', name: 'Företagskonto' }] },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('rejects an empty account list with 400', async () => {
    const request = createMockRequest('/api/import/sie/create-accounts', {
      method: 'POST',
      body: { accounts: [] },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Inga konton att skapa.')
  })

  it('upserts the accounts and reports how many were created', async () => {
    // Single batch upsert returning the inserted account numbers.
    enqueue({ data: [{ account_number: '1930' }, { account_number: '3001' }] })

    const request = createMockRequest('/api/import/sie/create-accounts', {
      method: 'POST',
      body: {
        accounts: [
          { number: '1930', name: 'Företagskonto' },
          { number: '3001', name: 'Försäljning tjänster 25%' },
        ],
      },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ success: boolean; created: number }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.created).toBe(2)
  })
})
