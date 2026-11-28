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
    row_type: 'order',
    status: 'completed',
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    manually_booked_at: null,
    manually_voided: false,
    legacy_transaction_id: null,
    ...overrides,
  }
}

/** An order the store cancelled, with nothing refunded. */
function cancelledRow(overrides: Record<string, unknown> = {}) {
  return makeOrderRow({ status: 'cancelled', ...overrides })
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
    enqueue({ data: { id: 'txn-1' } }) // open_bank_rows answers it
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN')
    expect(findCalls('open_bank_rows', 'eq')).toEqual([
      ['id', 'txn-1'],
      ['company_id', 'company-1'],
    ])
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('marks when the legacy feed transaction is not open work: ignored or booked, no open twin remains', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: null }) // open_bank_rows leaves it out
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postMark())
    expect(status).toBe(200)
    expect(findCall('open_bank_rows', 'select')).toEqual(['id'])
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

describe('POST /api/webshop-orders/[id]/mark-booked with voided: true', () => {
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
    const { status } = await parseJsonResponse(await postMark({ voided: true }))
    expect(status).toBe(401)
  })

  it('returns 400 when a void also names a verifikat', async () => {
    const { status } = await parseJsonResponse(
      await postMark({ voided: true, journal_entry_id: ENTRY_UUID }),
    )
    expect(status).toBe(400)
    expect(findCall('webshop_orders', 'select')).toBeUndefined()
  })

  it('returns 404 when the order does not exist for the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
  })

  it('voids a cancelled order: who and when, no verifikat, through the conditional claim', async () => {
    enqueue({ data: cancelledRow({ is_paid: true }) }) // fetch
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status, body } = await parseJsonResponse<{ success: boolean }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    const payload = findCall('webshop_orders', 'update')![0] as Record<string, unknown>
    expect(typeof payload.manually_booked_at).toBe('string')
    expect(payload.manually_booked_by).toBe('user-1')
    expect(payload.manually_booked_journal_entry_id).toBeNull()
    expect(payload.manually_voided).toBe(true)
    expect(findCalls('webshop_orders', 'is')).toEqual(
      expect.arrayContaining([
        ['journal_entry_id', null],
        ['invoice_id', null],
        ['manually_booked_at', null],
      ]),
    )
    // The store's state is checked again at the write.
    expect(findCalls('webshop_orders', 'eq')).toEqual(
      expect.arrayContaining([
        ['row_type', 'order'],
        ['status', 'cancelled'],
        ['refunded_total', 0],
      ]),
    )
    // Never a delete: the row stays.
    expect(findCall('webshop_orders', 'delete')).toBeUndefined()
  })

  it('refuses to void while the same money is an open row in the legacy feed: book or ignore it first', async () => {
    enqueue({ data: cancelledRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1' } }) // open_bank_rows answers it
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await postMark({ voided: true }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN')
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('voids once the legacy feed row is booked or ignored', async () => {
    enqueue({ data: cancelledRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: null }) // open_bank_rows leaves it out
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postMark({ voided: true }))
    expect(status).toBe(200)
  })

  it('refuses an order the store does not report cancelled', async () => {
    enqueue({ data: makeOrderRow({ status: 'processing' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_CANCELLED')
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('refuses a refund row: only the order itself is cancelled in the store', async () => {
    enqueue({ data: cancelledRow({ row_type: 'refund', status: 'refund' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_CANCELLED')
  })

  it('refuses a cancelled order the store refunded money on: the payment and the refund are booked', async () => {
    enqueue({ data: cancelledRow({ refunded_total: 499 }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_CANCELLED_WITH_REFUND')
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('refuses a cancelled order that is booked or invoiced', async () => {
    enqueue({ data: cancelledRow({ journal_entry_id: 'je-1' }) })
    const booked = await parseJsonResponse<{ error: { code: string } }>(await postMark({ voided: true }))
    expect(booked.status).toBe(409)
    expect(booked.body.error.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')

    enqueue({ data: cancelledRow({ invoice_id: 'inv-1' }) })
    const invoiced = await parseJsonResponse<{ error: { code: string } }>(await postMark({ voided: true }))
    expect(invoiced.status).toBe(409)
    expect(invoiced.body.error.code).toBe('WEBSHOP_ORDER_ALREADY_INVOICED')
  })

  it('refuses a cancelled order already marked as booked outside: undo that mark first', async () => {
    enqueue({ data: cancelledRow({ manually_booked_at: '2026-08-01T00:00:00Z' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_MANUALLY_BOOKED')
  })

  it('is idempotent for an order already voided', async () => {
    enqueue({ data: cancelledRow({ manually_booked_at: '2026-08-01T00:00:00Z', manually_voided: true }) })
    const { status, body } = await parseJsonResponse<{ already_marked: boolean }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(200)
    expect(body.already_marked).toBe(true)
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('returns 409 when the claim matches zero rows: booked, marked, reopened or refunded meanwhile', async () => {
    enqueue({ data: cancelledRow() })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ voided: true }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_VOID_RACED')
  })

  it('refuses marking a voided order as booked, or linking a verifikat to it', async () => {
    const voided = { manually_booked_at: '2026-08-01T00:00:00Z', manually_voided: true }
    enqueue({ data: cancelledRow(voided) })
    const bare = await parseJsonResponse<{ error: { code: string } }>(await postMark())
    expect(bare.status).toBe(409)
    expect(bare.body.error.code).toBe('WEBSHOP_ORDER_VOIDED')

    enqueue({ data: cancelledRow(voided) })
    const linked = await parseJsonResponse<{ error: { code: string } }>(
      await postMark({ journal_entry_id: ENTRY_UUID }),
    )
    expect(linked.status).toBe(409)
    expect(linked.body.error.code).toBe('WEBSHOP_ORDER_VOIDED')
    expect(findCall('webshop_orders', 'update')).toBeUndefined()
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
      manually_voided: false,
    })
  })
})
