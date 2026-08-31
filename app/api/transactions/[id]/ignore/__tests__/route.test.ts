import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

/** The three junction lookups the shared core runs for an unbooked row. */
function enqueueNoAnchors() {
  enqueue({ data: [], error: null }) // transaction_voucher_links
  enqueue({ data: [], error: null }) // invoice_payments
  enqueue({ data: [], error: null }) // supplier_invoice_payments
}

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
    enqueue({ data: null, error: null }) // maybeSingle: no row

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
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('returns 409 for a bulk-booked row whose verifikat lives in transaction_voucher_links (issue #1661)', async () => {
    // journal_entry_id stays NULL for N>1 bulk bookings: the old bare check
    // would have let this row be ignored while a verifikat still carries it.
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: false }, error: null })
    enqueue({ data: [{ transaction_id: 'tx-1' }], error: null }) // transaction_voucher_links
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('redan bokförd')
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('is idempotent when the transaction is already ignored', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: true }, error: null })
    enqueueNoAnchors()

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, already_ignored: true })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('marks the transaction ignored (happy path)', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: false }, error: null }) // fetch
    enqueueNoAnchors()
    enqueue({ data: null, error: null }) // update

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: true }]])
  })

  it('returns 500 when the update fails', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: false }, error: null }) // fetch
    enqueueNoAnchors()
    enqueue({ data: null, error: { message: 'db down' } }) // update fails

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'Något gick fel. Försök igen.' })
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

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-999/ignore', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Transaction not found' })
  })

  it('clears the ignore flag (happy path)', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: true }, error: null }) // fetch
    enqueue({ data: null, error: null }) // update

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: false }]])
  })

  it('returns 500 when the update fails', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null, is_ignored: true }, error: null }) // fetch
    enqueue({ data: null, error: { message: 'db down' } }) // update fails

    const request = createMockRequest('/api/transactions/tx-1/ignore', { method: 'DELETE' })
    const response = await DELETE(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'Något gick fel. Försök igen.' })
  })
})
