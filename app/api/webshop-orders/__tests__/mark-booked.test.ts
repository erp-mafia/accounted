import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } =
  createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST, DELETE } from '../[id]/mark-booked/route'

const ENTRY_UUID = '550e8400-e29b-41d4-a716-446655440001'

function makeOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    journal_entry_id: null,
    invoice_id: null,
    manually_booked_at: null,
    legacy_transaction_id: null,
    ...overrides,
  }
}

function postMark(body: unknown = {}, id = 'order-1') {
  const request = createMockRequest(`/api/webshop-orders/${id}/mark-booked`, {
    method: 'POST',
    body,
  })
  return POST(request, createMockRouteParams({ id }))
}

function deleteMark(id = 'order-1') {
  const request = createMockRequest(`/api/webshop-orders/${id}/mark-booked`, {
    method: 'DELETE',
  })
  return DELETE(request, createMockRouteParams({ id }))
}

describe('POST /api/webshop-orders/[id]/mark-booked', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await postMark())
    expect(status).toBe(401)
  })

  it('returns 403 when the caller is a viewer (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await postMark())
    expect(status).toBe(403)
  })

  it('returns 400 on an invalid journal_entry_id', async () => {
    const { status } = await parseJsonResponse(
      await postMark({ journal_entry_id: 'not-a-uuid' }),
    )
    expect(status).toBe(400)
  })

  it('returns 404 when the order does not exist for the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark(),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
  })

  it('returns 409 when the order is booked through the integration', async () => {
    enqueue({ data: makeOrderRow({ journal_entry_id: 'je-1' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
  })

  it('returns 409 when the order is invoiced', async () => {
    enqueue({ data: makeOrderRow({ invoice_id: 'inv-1' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_INVOICED')
  })

  it('is idempotent for a bare re-mark of an already-marked row', async () => {
    enqueue({ data: makeOrderRow({ manually_booked_at: '2026-08-01T00:00:00Z' }) })
    const { status, body } = await parseJsonResponse<{ already_marked: boolean }>(
      await postMark(),
    )
    expect(status).toBe(200)
    expect(body.already_marked).toBe(true)
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('updates the verifikat link when re-marking with a journal_entry_id', async () => {
    enqueue({ data: makeOrderRow({ manually_booked_at: '2026-08-01T00:00:00Z' }) })
    enqueue({ data: { id: ENTRY_UUID, status: 'posted' } }) // entry lookup
    enqueue({ data: null }) // link update
    const { status, body } = await parseJsonResponse<{
      already_marked: boolean
      link_updated: boolean
    }>(await postMark({ journal_entry_id: ENTRY_UUID }))
    expect(status).toBe(200)
    expect(body.already_marked).toBe(true)
    expect(body.link_updated).toBe(true)
    const update = findCall('webshop_orders', 'update')
    expect(update![0]).toEqual({ manually_booked_journal_entry_id: ENTRY_UUID })
  })

  it('refuses to mark while the legacy feed transaction is still OPEN (double-booking gate)', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: null, is_ignored: false } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN')
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('marks when the legacy feed transaction was ignored', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: null, is_ignored: true } })
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postMark())
    expect(status).toBe(200)
  })

  it('marks when the legacy feed transaction is already booked (no open twin remains)', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: 'je-77', is_ignored: false } })
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postMark())
    expect(status).toBe(200)
  })

  it('marks the row with who/when via a conditional claim', async () => {
    enqueue({ data: makeOrderRow() }) // fetch
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status, body } = await parseJsonResponse<{ success: boolean }>(await postMark())
    expect(status).toBe(200)
    expect(body.success).toBe(true)

    const update = findCall('webshop_orders', 'update')
    expect(update).toBeDefined()
    const payload = update![0] as Record<string, unknown>
    expect(typeof payload.manually_booked_at).toBe('string')
    expect(payload.manually_booked_by).toBe('user-1')
    expect(payload.manually_booked_journal_entry_id).toBeNull()

    // The claim must exclude rows already booked, invoiced or marked.
    const isFilters = findCalls('webshop_orders', 'is')
    expect(isFilters).toEqual(
      expect.arrayContaining([
        ['journal_entry_id', null],
        ['invoice_id', null],
        ['manually_booked_at', null],
      ]),
    )
  })

  it('links a posted verifikat when journal_entry_id is provided', async () => {
    enqueue({ data: makeOrderRow() }) // fetch order
    enqueue({ data: { id: ENTRY_UUID, status: 'posted' } }) // entry lookup
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(
      await postMark({ journal_entry_id: ENTRY_UUID }),
    )
    expect(status).toBe(200)
    const update = findCall('webshop_orders', 'update')
    expect((update![0] as Record<string, unknown>).manually_booked_journal_entry_id).toBe(
      ENTRY_UUID,
    )
  })

  it('returns 404 when the linked verifikat does not exist in the company', async () => {
    enqueue({ data: makeOrderRow() })
    enqueue({ data: null }) // entry lookup
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ journal_entry_id: ENTRY_UUID }),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_MARK_ENTRY_NOT_FOUND')
  })

  it('refuses linking a non-posted verifikat', async () => {
    enqueue({ data: makeOrderRow() })
    enqueue({ data: { id: ENTRY_UUID, status: 'draft' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ journal_entry_id: ENTRY_UUID }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_MARK_ENTRY_NOT_POSTED')
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('returns 409 when the claim matches zero rows (raced)', async () => {
    enqueue({ data: makeOrderRow() }) // fetch (sees open row)
    enqueue({ data: [] }) // claim matched zero rows
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
  })
})

describe('DELETE /api/webshop-orders/[id]/mark-booked', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await deleteMark())
    expect(status).toBe(401)
  })

  it('returns 404 when the order does not exist for the company', async () => {
    enqueue({ data: [] }) // update matched zero rows
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await deleteMark(),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
  })

  it('clears the mark fields', async () => {
    enqueue({ data: [{ id: 'order-1' }] })
    const { status, body } = await parseJsonResponse<{ success: boolean }>(await deleteMark())
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    const update = findCall('webshop_orders', 'update')
    expect(update![0]).toEqual({
      manually_booked_at: null,
      manually_booked_by: null,
      manually_booked_journal_entry_id: null,
    })
  })
})
