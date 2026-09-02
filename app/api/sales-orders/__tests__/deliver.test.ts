/**
 * POST /api/sales-orders/[id]/deliver (cumulative delivered quantities).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import { IDS, makeSalesOrder, makeSalesOrderItem } from '@/lib/sales-orders/__tests__/fixtures'
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

import { POST } from '../[id]/deliver/route'

const params = createMockRouteParams({ id: IDS.order })

function post(body: unknown) {
  return POST(createMockRequest(`/api/sales-orders/${IDS.order}/deliver`, { method: 'POST', body }), params)
}

const confirmed = (delivered = 0) =>
  makeSalesOrder({
    status: 'confirmed',
    confirmed_at: '2026-09-01T10:00:00Z',
    items: [makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: delivered })],
  })

describe('POST /api/sales-orders/[id]/deliver', () => {
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
    const { status } = await parseJsonResponse(
      await post({ lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] }),
    )
    expect(status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty lines array', async () => {
    const { status } = await parseJsonResponse(await post({ lines: [] }))
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a negative delivered quantity', async () => {
    const { status } = await parseJsonResponse(
      await post({ lines: [{ sales_order_item_id: IDS.item1, delivered_qty: -1 }] }),
    )
    expect(status).toBe(400)
  })

  it('returns 400 for a malformed delivery_date', async () => {
    const { status } = await parseJsonResponse(
      await post({ delivery_date: '02/09/2026', lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] }),
    )
    expect(status).toBe(400)
  })

  it('returns 404 when the order is missing', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] }),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALES_ORDER_NOT_FOUND')
  })

  it('returns 409 SALES_ORDER_INVALID_STATE for a draft order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_INVALID_STATE')
  })

  it('returns 400 SALES_ORDER_OVER_DELIVERED when delivering more than ordered', async () => {
    enqueue({ data: confirmed() })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await post({ lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 11 }] }),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('SALES_ORDER_OVER_DELIVERED')
    expect(body.error.details).toMatchObject({ quantity: 10, delivered_qty: 11 })
    expect(findCall('sales_order_items', 'update')).toBeUndefined()
  })

  it('registers the delivery and answers with the reloaded order', async () => {
    enqueue({ data: confirmed(0) })
    enqueue({ data: [] })
    enqueue({ data: null }) // line update
    enqueue({ data: null }) // last_delivery_date update
    enqueue({ data: { ...confirmed(6), last_delivery_date: '2026-09-02' } })
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<{ data: SalesOrder }>(
      await post({ delivery_date: '2026-09-02', lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 6 }] }),
    )

    expect(status).toBe(200)
    expect(body.data.last_delivery_date).toBe('2026-09-02')
    expect(body.data.delivery_progress).toBe('partial')
    expect(body.data.items?.[0].delivered_qty).toBe(6)
    expect(findCall('sales_order_items', 'update')![0]).toEqual({ delivered_qty: 6 })
    expect(findCall('sales_orders', 'update')![0]).toEqual({ last_delivery_date: '2026-09-02' })
  })
})
