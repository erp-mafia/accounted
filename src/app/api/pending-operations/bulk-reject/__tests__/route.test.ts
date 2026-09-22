import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST } from '../route'

const VALID_ID_1 = '11111111-1111-4111-8111-111111111111'
const VALID_ID_2 = '22222222-2222-4222-8222-222222222222'
const VALID_ID_3 = '33333333-3333-4333-8333-333333333333'

type ResultBody = {
  data: {
    results: Array<{ id: string; status: string; error?: string }>
    summary: { total: number; rejected: number; skipped: number; failed: number }
  }
}

describe('POST /api/pending-operations/bulk-reject', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('returns 400 when ids array is empty', async () => {
    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [] },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('returns 400 for an unknown rejection_category', async () => {
    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1], rejection_category: 'not_a_category' },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('returns 500 when fetching pending operations fails', async () => {
    enqueue({ data: null, error: { message: 'db connection lost' } })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    // Raw Supabase messages never reach the response field.
    expect(body.error).toBe('Åtgärderna kunde inte hämtas. Försök igen.')
  })

  it('reports per-item not-found as failed without running an update', async () => {
    // Only the fetch result is enqueued: with no pending ids the route must
    // not issue the UPDATE query at all.
    enqueue({ data: [] })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<ResultBody>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'failed', error: 'Åtgärden kunde inte hittas.' },
    ])
    expect(body.data.summary).toEqual({ total: 1, rejected: 0, skipped: 0, failed: 1 })
  })

  it('skips already-handled operations with a Swedish status label', async () => {
    enqueue({
      data: [
        { id: VALID_ID_1, status: 'committed' },
        { id: VALID_ID_2, status: 'rejected' },
      ],
    })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<ResultBody>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'skipped', error: 'Redan hanterad (godkänd)' },
      { id: VALID_ID_2, status: 'skipped', error: 'Redan hanterad (avvisad)' },
    ])
    expect(body.data.summary).toEqual({ total: 2, rejected: 0, skipped: 2, failed: 0 })
  })

  it('rejects pending operations and aggregates a mixed summary', async () => {
    enqueue({
      data: [
        { id: VALID_ID_1, status: 'pending' },
        { id: VALID_ID_2, status: 'pending' },
        { id: VALID_ID_3, status: 'committed' },
      ],
    })
    // The guarded UPDATE returns the rows it actually flipped.
    enqueue({ data: [{ id: VALID_ID_1 }, { id: VALID_ID_2 }] })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: {
        ids: [VALID_ID_1, VALID_ID_2, VALID_ID_3],
        rejection_category: 'duplicate',
        rejection_reason: 'Samma underlag stagat två gånger',
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<ResultBody>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'rejected' },
      { id: VALID_ID_2, status: 'rejected' },
      { id: VALID_ID_3, status: 'skipped', error: 'Redan hanterad (godkänd)' },
    ])
    expect(body.data.summary).toEqual({ total: 3, rejected: 2, skipped: 1, failed: 0 })
  })

  it('returns 500 when the update fails', async () => {
    enqueue({ data: [{ id: VALID_ID_1, status: 'pending' }] })
    enqueue({ data: null, error: { message: 'update exploded' } })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('Operationerna kunde inte avvisas. Försök igen.')
  })

  it('marks a row resolved between read and write as skipped', async () => {
    enqueue({ data: [{ id: VALID_ID_1, status: 'pending' }] })
    // Guarded UPDATE found nothing still pending.
    enqueue({ data: [] })

    const request = createMockRequest('/api/pending-operations/bulk-reject', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<ResultBody>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'skipped', error: 'Hanterades i en annan session.' },
    ])
    expect(body.data.summary).toEqual({ total: 1, rejected: 0, skipped: 1, failed: 0 })
  })
})
