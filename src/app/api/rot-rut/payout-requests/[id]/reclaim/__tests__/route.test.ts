import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockReclaim = vi.fn()
vi.mock('@/lib/invoices/rot-rut-reclaim', () => ({
  reclaimRotRutRefusal: (...args: unknown[]) => mockReclaim(...args),
}))

import { POST } from '../route'

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const mockUser = { id: 'user-1', email: 'test@test.se' }
const routeParams = createMockRouteParams({ id: REQUEST_ID })

function makeReq(body: unknown = { booking_date: '2026-08-21' }) {
  return createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/reclaim`, {
    method: 'POST',
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  mockReclaim.mockResolvedValue({
    ok: true,
    journalEntryId: 'je-reclaim',
    reclaimedTotal: 2000,
    invoices: [
      { invoice_id: 'inv-1', invoice_number: '2026-002', reclaimed_amount: 2000, remaining_amount: 2000, status: 'partially_paid' },
    ],
  })
})

describe('POST /api/rot-rut/payout-requests/[id]/reclaim', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeReq(), routeParams)
    expect(response.status).toBe(401)
    expect(mockReclaim).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body', async () => {
    const response = await POST(makeReq({ booking_date: 'yesterday' }), routeParams)
    expect(response.status).toBe(400)
    expect(mockReclaim).not.toHaveBeenCalled()
  })

  it('returns 404 when the request is not in the company', async () => {
    mockReclaim.mockResolvedValue({ ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('ROT_RUT_REQUEST_NOT_FOUND')
  })

  it('maps service refusals to their structured codes', async () => {
    mockReclaim.mockResolvedValue({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN',
      details: { request_id: REQUEST_ID },
    })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('ROT_RUT_RECLAIM_SPLIT_UNKNOWN')

    mockReclaim.mockResolvedValue({ ok: false, kind: 'code', code: 'ROT_RUT_RECLAIM_ALREADY_DONE' })
    const conflict = await POST(makeReq(), routeParams)
    expect(conflict.status).toBe(409)
  })

  it('books the reclaim with the caller as acting user and the body date', async () => {
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{
      data: { journal_entry_id: string; reclaimed_total: number; invoices: unknown[] }
    }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual({
      journal_entry_id: 'je-reclaim',
      reclaimed_total: 2000,
      invoices: [
        { invoice_id: 'inv-1', invoice_number: '2026-002', reclaimed_amount: 2000, remaining_amount: 2000, status: 'partially_paid' },
      ],
    })
    expect(mockReclaim).toHaveBeenCalledWith(mockSupabase, 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      bookingDate: '2026-08-21',
    })
  })

  it('returns 500 when the engine refuses to book', async () => {
    mockReclaim.mockResolvedValue({
      ok: false,
      kind: 'error',
      error: new Error('No open fiscal period'),
      stage: 'book',
    })
    const response = await POST(makeReq(), routeParams)
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
