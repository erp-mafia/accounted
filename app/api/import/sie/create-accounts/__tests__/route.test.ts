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
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it.each(['999', '193000', '19A0', 1930])('rejects invalid account %j before creating any accounts', async number => {
    const response = await POST(createMockRequest('/api/import/sie/create-accounts', {
      method: 'POST', body: { accounts: [{ number: '1930', name: 'Bank' }, { number, name: 'Invalid' }] },
    }), emptyParams)
    expect(response.status).toBe(400)
    expect((await response.json()).error.details.issues[0].field).toBe('accounts.1.number')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each([null, {}, { accounts: [null] }, { accounts: [{ number: '1930' }] }])('returns 400 for malformed account input: %j', body => {
    return POST(createMockRequest('/api/import/sie/create-accounts', { method: 'POST', body }), emptyParams)
      .then(response => expect(response.status).toBe(400))
  })

  it.each(['999', '193000'])('identifies rejected source account %s with localized mapping guidance', async number => {
    const response = await POST(createMockRequest('/api/import/sie/create-accounts', {
      method: 'POST', body: { accounts: [{ number: '1930', name: 'Bank' }, { number, name: 'Source' }] },
    }), emptyParams)
    expect(response.status).toBe(400)
    const { error } = await response.json()
    expect(error.details.issues[0]).toMatchObject({ field: 'accounts.1.number', sourceAccount: number })
    expect(error.message).toBe(`Källkonto ${number}: Kontot kunde inte skapas. Välj ett målkonto med exakt fyra siffror i kontomappningen.`)
    expect(error.message_en).toBe(`Source account ${number}: The account could not be created. Select a target account with exactly four digits in the account mapping step.`)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each(['9'.repeat(41), '<script>alert(1)</script>', 1930])('does not echo unbounded or non-string account metadata: %j', async number => {
    const response = await POST(createMockRequest('/api/import/sie/create-accounts', {
      method: 'POST', body: { accounts: [{ number, name: 'Source' }] },
    }), emptyParams)
    const { error } = await response.json()
    expect(response.status).toBe(400)
    expect(error.details.issues[0]).not.toHaveProperty('sourceAccount')
    expect(error.message).not.toContain(String(number))
    expect(error.message_en).not.toContain(String(number))
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON before chart writes', async () => {
    const response = await POST(new Request('https://example.test/api/import/sie/create-accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken',
    }), emptyParams)
    expect(response.status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
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
