/**
 * GET/POST /api/sales-orders (kundorder list + create), through the real
 * withRouteContext wrapper with its auth/company/write dependencies mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { IDS, makeOrderCustomer, makeSalesOrder, makeSalesOrderItem, invoicedRow } from '@/lib/sales-orders/__tests__/fixtures'
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

import { GET, POST } from '../route'

const noParams = { params: Promise.resolve({}) }
const validLine = { description: 'Konsulttimme', quantity: 10, unit: 'h', unit_price: 100, vat_rate: 25 }

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

describe('GET /api/sales-orders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: IDS.user }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const { status } = await parseJsonResponse(await GET(createMockRequest('/api/sales-orders'), noParams))
    expect(status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown status filter', async () => {
    const request = createMockRequest('/api/sales-orders', { searchParams: { status: 'shipped' } })
    const { status } = await parseJsonResponse(await GET(request, noParams))
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('lists orders decorated with invoiced quantities and progress', async () => {
    enqueue({
      data: [
        makeSalesOrder({ items: [makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 10 })] }),
        makeSalesOrder({ id: 'a1000000-0000-4000-8000-000000000002', status: 'confirmed', items: [] }),
      ],
    })
    enqueue({ data: [invoicedRow(IDS.item1, '4')] })

    const request = createMockRequest('/api/sales-orders', { searchParams: { status: 'draft', q: 'OR-1' } })
    const { status, body } = await parseJsonResponse<{ data: SalesOrder[] }>(await GET(request, noParams))

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].items?.[0]).toMatchObject({ invoiced_qty: 4, remaining_qty: 6 })
    expect(body.data[0].delivery_progress).toBe('full')
    expect(body.data[0].invoicing_progress).toBe('partial')
    expect(body.data[1].delivery_progress).toBe('none')
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['company_id', IDS.company])
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['status', 'draft'])
    expect(findCall('sales_orders', 'ilike')).toEqual(['order_number', '%OR-1%'])
    expect(supabase.rpc).toHaveBeenCalledWith('sales_order_invoiced_quantities', { p_order_ids: [IDS.order, 'a1000000-0000-4000-8000-000000000002'] })
  })

  it('returns an empty list without calling the RPC when there are no orders', async () => {
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await GET(createMockRequest('/api/sales-orders'), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual([])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/sales-orders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: IDS.user }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  function post(body: unknown) {
    return POST(createMockRequest('/api/sales-orders', { method: 'POST', body }), noParams)
  }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const { status } = await parseJsonResponse(await post({ customer_id: IDS.customer, items: [validLine] }))
    expect(status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await post({ customer_id: IDS.customer, items: [validLine] }))
    expect(status).toBe(403)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 when items are missing', async () => {
    const { status } = await parseJsonResponse(await post({ customer_id: IDS.customer }))
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 when customer_id is not a uuid', async () => {
    const { status } = await parseJsonResponse(await post({ customer_id: 'kund-1', items: [validLine] }))
    expect(status).toBe(400)
  })

  it('returns 400 for a product line with an empty description', async () => {
    const { status } = await parseJsonResponse(
      await post({ customer_id: IDS.customer, items: [{ ...validLine, description: '   ' }] }),
    )
    expect(status).toBe(400)
  })

  it('returns 404 when the customer does not exist in the company', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ customer_id: IDS.customer, items: [validLine] }),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('CUSTOMER_NOT_FOUND')
  })

  it('returns 400 INVOICE_CREATE_VAT_RULE_VIOLATION for a rate the customer type forbids', async () => {
    enqueue({ data: makeOrderCustomer({ customer_type: 'non_eu_business' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await post({ customer_id: IDS.customer, items: [{ ...validLine, vat_rate: 20 }] }),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
    expect(findCall('sales_orders', 'insert')).toBeUndefined()
  })

  it('creates a draft order and answers 201 with the loaded order', async () => {
    enqueue({ data: makeOrderCustomer() }) // customer lookup
    enqueue({ data: { id: IDS.order } }) // header insert
    enqueue({ data: null }) // lines insert
    enqueue({ data: 'OR-1' }) // generate_sales_order_number
    enqueue({ data: makeSalesOrder({ order_number: 'OR-1' }) }) // reload
    enqueue({ data: [] }) // invoiced quantities

    const { status, body } = await parseJsonResponse<{ data: SalesOrder }>(
      await post({
        customer_id: IDS.customer,
        order_date: '2026-09-01',
        items: [validLine, { line_type: 'text', description: 'Leverans v.36', quantity: 0, unit: '', unit_price: 0 }],
      }),
    )

    expect(status).toBe(201)
    expect(body.data.id).toBe(IDS.order)
    expect(body.data.order_number).toBe('OR-1')
    expect(body.data.status).toBe('draft')
    expect(body.data.delivery_progress).toBe('none')
    expect(body.data.invoicing_progress).toBe('none')
    expect(findCall('sales_orders', 'insert')![0]).toMatchObject({
      company_id: IDS.company,
      user_id: IDS.user,
      customer_id: IDS.customer,
      status: 'draft',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
    })
    const lines = findCall('sales_order_items', 'insert')![0] as unknown[]
    expect(lines).toHaveLength(2)
  })
})
