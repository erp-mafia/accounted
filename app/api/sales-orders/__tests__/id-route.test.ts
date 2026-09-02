/**
 * GET/PATCH/DELETE /api/sales-orders/[id].
 *
 * Queue order for loadSalesOrder: sales_orders select, then the
 * sales_order_invoiced_quantities RPC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import { IDS, invoicedRow, makeOrderCustomer, makeSalesOrder, makeSalesOrderItem } from '@/lib/sales-orders/__tests__/fixtures'
import type { SalesOrder } from '@/types'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

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

import { GET, PATCH, DELETE } from '../[id]/route'

const params = createMockRouteParams({ id: IDS.order })
const url = `/api/sales-orders/${IDS.order}`

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: IDS.user }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/sales-orders/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const { status } = await parseJsonResponse(await GET(createMockRequest(url), params))
    expect(status).toBe(401)
  })

  it('returns 404 when the order is missing', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest(url), params),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALES_ORDER_NOT_FOUND')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns the order with sorted lines, derived quantities and a masked customer', async () => {
    enqueue({
      data: makeSalesOrder({
        customer: makeOrderCustomer({ customer_type: 'individual', personal_number: '199001011234' }),
        items: [
          makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 5 }),
          makeSalesOrderItem({ id: IDS.item1, sort_order: 0, quantity: 10, delivered_qty: 3 }),
        ],
      }),
    })
    enqueue({ data: [invoicedRow(IDS.item1, '2')] })

    const { status, body } = await parseJsonResponse<{ data: SalesOrder }>(await GET(createMockRequest(url), params))

    expect(status).toBe(200)
    expect(body.data.id).toBe(IDS.order)
    expect(body.data.items?.map((i) => i.id)).toEqual([IDS.item1, IDS.item2])
    expect(body.data.items?.[0]).toMatchObject({ invoiced_qty: 2, remaining_qty: 8 })
    expect(body.data.items?.[1]).toMatchObject({ invoiced_qty: 0, remaining_qty: 5 })
    expect(body.data.delivery_progress).toBe('partial')
    expect(body.data.invoicing_progress).toBe('partial')
    // The embedded customer never carries the raw personnummer out.
    expect(body.data.customer?.personal_number).not.toBe('199001011234')
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['id', IDS.order])
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['company_id', IDS.company])
  })
})

describe('PATCH /api/sales-orders/[id]', () => {
  function patch(body: unknown) {
    return PATCH(createMockRequest(url, { method: 'PATCH', body }), params)
  }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const { status } = await parseJsonResponse(await patch({ notes: 'x' }))
    expect(status).toBe(401)
  })

  it('returns 400 for an empty items array', async () => {
    const { status } = await parseJsonResponse(await patch({ items: [] }))
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for an unsupported currency', async () => {
    const { status } = await parseJsonResponse(await patch({ currency: 'CHF' }))
    expect(status).toBe(400)
  })

  it('returns 404 when the order is missing', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch({ notes: 'x' }))
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALES_ORDER_NOT_FOUND')
  })

  it('returns 409 SALES_ORDER_NOT_EDITABLE for a completed order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'completed' }) })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch({ notes: 'x' }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_NOT_EDITABLE')
  })

  it('returns 409 SALES_ORDER_LINE_LOCKED when an invoiced line is dropped', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed', items: [makeSalesOrderItem({ id: IDS.item1 })] }) })
    enqueue({ data: [invoicedRow(IDS.item1, 2)] })
    enqueue({ data: makeOrderCustomer() })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await patch({ items: [{ description: 'Ny rad', quantity: 1, unit: 'st', unit_price: 10, vat_rate: 25 }] }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_LINE_LOCKED')
    expect(body.error.details).toMatchObject({ sales_order_item_id: IDS.item1 })
  })

  it('updates the header and answers with the reloaded order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: null }) // header update
    enqueue({ data: makeSalesOrder({ status: 'draft', notes: 'Ring innan leverans' }) })
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<{ data: SalesOrder }>(
      await patch({ notes: 'Ring innan leverans' }),
    )

    expect(status).toBe(200)
    expect(body.data.notes).toBe('Ring innan leverans')
    expect(body.data.delivery_progress).toBe('none')
    expect(findCall('sales_orders', 'update')![0]).toMatchObject({ notes: 'Ring innan leverans' })
  })
})

describe('DELETE /api/sales-orders/[id]', () => {
  function del() {
    return DELETE(createMockRequest(url, { method: 'DELETE' }), params)
  }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const { status } = await parseJsonResponse(await del())
    expect(status).toBe(401)
  })

  it('returns 404 when the order is missing', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await del())
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALES_ORDER_NOT_FOUND')
    expect(findCall('sales_orders', 'delete')).toBeUndefined()
  })

  it('returns 409 for a confirmed order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await del(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_INVALID_STATE')
    expect(body.error.details).toMatchObject({ status: 'confirmed', action: 'delete' })
    expect(findCall('sales_orders', 'delete')).toBeUndefined()
  })

  it('returns 409 SALES_ORDER_HAS_INVOICES when an invoice is linked', async () => {
    enqueue({ data: makeSalesOrder({ status: 'cancelled' }) })
    enqueue({ data: [] })
    enqueue({ data: [] }) // hasOpenInvoices rpc
    enqueue({ data: null, count: 1 }) // header-linked invoice
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await del())
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_HAS_INVOICES')
    expect(findCall('sales_orders', 'delete')).toBeUndefined()
  })

  it('hard-deletes a draft with no invoices', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null, count: 0 })
    enqueue({ data: null }) // delete

    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(await del())

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: IDS.order, deleted: true })
    expect(findCall('sales_orders', 'delete')).toBeDefined()
    const eqs = findCalls('sales_orders', 'eq')
    expect(eqs).toContainEqual(['id', IDS.order])
    expect(eqs).toContainEqual(['company_id', IDS.company])
  })
})
