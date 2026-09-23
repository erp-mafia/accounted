/**
 * POST /api/sales-orders/[id]/transition (confirm | cancel | reopen).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import { IDS, invoicedRow, makeSalesOrder } from '@/lib/sales-orders/__tests__/fixtures'
import type { SalesOrder } from '@/types'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

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

import { POST } from '../[id]/transition/route'

const params = createMockRouteParams({ id: IDS.order })

function post(body: unknown) {
  return POST(createMockRequest(`/api/sales-orders/${IDS.order}/transition`, { method: 'POST', body }), params)
}

describe('POST /api/sales-orders/[id]/transition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: IDS.user }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await post({ action: 'confirm' }))
    expect(status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await post({ action: 'confirm' }))
    expect(status).toBe(403)
  })

  it('returns 400 for an unknown action', async () => {
    const { status } = await parseJsonResponse(await post({ action: 'ship' }))
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a missing body', async () => {
    const { status } = await parseJsonResponse(await post({}))
    expect(status).toBe(400)
  })

  it('returns 404 when the order is missing', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ action: 'confirm' }))
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALES_ORDER_NOT_FOUND')
  })

  it('returns 409 SALES_ORDER_INVALID_STATE for confirm on a confirmed order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await post({ action: 'confirm' }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_INVALID_STATE')
    expect(body.error.details).toMatchObject({ status: 'confirmed', action: 'confirm' })
  })

  it('returns 409 SALES_ORDER_HAS_INVOICES for cancel with a linked invoice', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [invoicedRow(IDS.item1, 1)] })
    enqueue({ data: [invoicedRow(IDS.item1, 1)] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ action: 'cancel' }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_HAS_INVOICES')
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('confirms a draft and answers with the reloaded order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: [{ id: IDS.order }] }) // CAS update
    enqueue({ data: null }) // refresh_sales_order_completion
    enqueue({ data: makeSalesOrder({ status: 'confirmed', confirmed_at: '2026-09-02T10:00:00Z' }) })
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<{ data: SalesOrder }>(await post({ action: 'confirm' }))

    expect(status).toBe(200)
    expect(body.data.status).toBe('confirmed')
    expect(body.data.confirmed_at).toBe('2026-09-02T10:00:00Z')
    expect(body.data.delivery_progress).toBe('none')
    expect(findCall('sales_orders', 'update')![0]).toMatchObject({ status: 'confirmed' })
    expect(supabase.rpc).toHaveBeenCalledWith('refresh_sales_order_completion', { p_order_id: IDS.order })
  })
})
