import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
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

import { POST, DELETE } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/transactions/[id]/ignore', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden' })
    // No DB read/write happens when the role gate rejects.
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Transaction not found' })
  })

  it('returns 409 when the transaction is already booked', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1', is_ignored: false }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('redan bokförd')
  })

  it('is idempotent when the transaction is already ignored', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: true }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, already_ignored: true })
  })

  it('marks the transaction ignored (happy path)', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: false }, error: null }) // fetch
    enqueue({ data: null, error: null }) // update

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
  })

  it('returns 500 when the update fails', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: false }, error: null }) // fetch
    enqueue({ data: null, error: { message: 'db down' } }) // update fails

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'db down' })
  })
})

describe('DELETE /api/transactions/[id]/ignore', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden' })
  })

  it('clears the ignore flag (happy path)', async () => {
    enqueue({ data: null, error: null }) // update

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
  })

  it('returns 500 when the update fails', async () => {
    enqueue({ data: null, error: { message: 'db down' } }) // update fails

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'db down' })
  })
})
