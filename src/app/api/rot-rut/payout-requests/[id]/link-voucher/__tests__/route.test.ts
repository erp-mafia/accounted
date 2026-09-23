import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
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

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockLink = vi.fn()
const mockCandidates = vi.fn()
vi.mock('@/lib/invoices/rot-rut-link-voucher', () => ({
  linkRotRutPayoutVoucher: (...args: unknown[]) => mockLink(...args),
  listRotRutPayoutVoucherCandidates: (...args: unknown[]) => mockCandidates(...args),
}))

import { GET, POST } from '../route'

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const VOUCHER_ID = '44444444-4444-4444-8444-444444444444'
const mockUser = { id: 'user-1', email: 'test@test.se' }
const routeParams = createMockRouteParams({ id: REQUEST_ID })
const URL = `/api/rot-rut/payout-requests/${REQUEST_ID}/link-voucher`

function makeReq(body: unknown = { journal_entry_id: VOUCHER_ID }) {
  return createMockRequest(URL, { method: 'POST', body })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  mockLink.mockResolvedValue({
    ok: true,
    result: {
      ok: true,
      dry_run: false,
      already_linked: false,
      journal_entry_id: VOUCHER_ID,
      expected_total: 671,
      voucher_1513_credit: 671.25,
      bank_amount: 671,
      rounding: 0.25,
    },
  })
})

describe('POST /api/rot-rut/payout-requests/[id]/link-voucher', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeReq(), routeParams)
    expect(response.status).toBe(401)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body', async () => {
    const response = await POST(makeReq({ journal_entry_id: 'A177' }), routeParams)
    expect(response.status).toBe(400)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('returns 404 when the request is not in the company', async () => {
    mockLink.mockResolvedValue({ ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('ROT_RUT_REQUEST_NOT_FOUND')
  })

  it('links the voucher, always including the route request', async () => {
    const response = await POST(
      makeReq({ journal_entry_id: VOUCHER_ID, request_ids: [OTHER_REQUEST_ID, REQUEST_ID] }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { rounding: number } }>(response)
    expect(status).toBe(200)
    expect(body.data.rounding).toBe(0.25)
    expect(mockLink).toHaveBeenCalledWith(mockSupabase, 'company-1', {
      requestIds: [REQUEST_ID, OTHER_REQUEST_ID],
      journalEntryId: VOUCHER_ID,
      dryRun: undefined,
    })
  })

  it('returns 409 when the voucher already settles another request', async () => {
    mockLink.mockResolvedValue({ ok: false, kind: 'code', code: 'ROT_RUT_LINK_VOUCHER_IN_USE' })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('ROT_RUT_LINK_VOUCHER_IN_USE')
  })

  it('returns 400 when the 1513 amount does not match', async () => {
    mockLink.mockResolvedValue({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_LINK_AMOUNT_MISMATCH',
      details: { expected_total: 671, voucher_1513_credit: 900 },
    })
    const response = await POST(makeReq(), routeParams)
    expect(response.status).toBe(400)
  })
})

describe('GET /api/rot-rut/payout-requests/[id]/link-voucher', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest(URL), routeParams)
    expect(response.status).toBe(401)
  })

  it('returns 404 for an unknown request', async () => {
    enqueue({ data: null })
    const response = await GET(createMockRequest(URL), routeParams)
    expect(response.status).toBe(404)
    expect(mockCandidates).not.toHaveBeenCalled()
  })

  it('lists candidates dated from the day the request was created', async () => {
    enqueue({ data: { id: REQUEST_ID, created_at: '2026-08-25T09:12:00Z' } })
    mockCandidates.mockResolvedValue({
      data: [{ journal_entry_id: VOUCHER_ID, receivable_credit: 671.25, bank_amount: 671 }],
      error: null,
    })
    const response = await GET(createMockRequest(URL), routeParams)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(mockCandidates).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-08-25')
  })
})
