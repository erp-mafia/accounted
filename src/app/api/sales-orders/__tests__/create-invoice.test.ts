/**
 * POST /api/sales-orders/[id]/create-invoice: unnumbered draft kundfaktura
 * from an order, with the invoice builder mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { IDS, invoicedRow, makeOrderCustomer, makeSalesOrder, makeSalesOrderItem } from '@/lib/sales-orders/__tests__/fixtures'
import type { Invoice, SalesOrder } from '@/types'

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

const mockBuildInvoiceWriteData = vi.fn()
vi.mock('@/lib/invoices/build-invoice-write', () => ({
  buildInvoiceWriteData: (...args: unknown[]) => mockBuildInvoiceWriteData(...args),
}))

import { POST } from '../[id]/create-invoice/route'

const params = createMockRouteParams({ id: IDS.order })

function post(body: unknown = {}) {
  return POST(createMockRequest(`/api/sales-orders/${IDS.order}/create-invoice`, { method: 'POST', body }), params)
}

const okBuild = {
  ok: true,
  invoiceFields: {
    customer_id: IDS.customer,
    invoice_date: '2026-09-02',
    due_date: '2026-10-02',
    currency: 'SEK',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
  },
  items: [
    {
      sort_order: 0,
      line_type: 'product',
      description: 'Konsulttimme',
      quantity: 10,
      unit: 'h',
      unit_price: 100,
      line_total: 1000,
      vat_rate: 25,
      vat_amount: 250,
      sales_order_item_id: IDS.item1,
    },
  ],
}

const confirmed = () =>
  makeSalesOrder({
    status: 'confirmed',
    confirmed_at: '2026-09-01T10:00:00Z',
    items: [makeSalesOrderItem({ id: IDS.item1, quantity: 10 })],
  })

describe('POST /api/sales-orders/[id]/create-invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: { id: IDS.user }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await post())
    expect(status).toBe(401)
    expect(mockBuildInvoiceWriteData).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await post())
    expect(status).toBe(403)
  })

  it('returns 400 for a picked line with quantity 0', async () => {
    const { status } = await parseJsonResponse(
      await post({ lines: [{ sales_order_item_id: IDS.item1, quantity: 0 }] }),
    )
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown mode', async () => {
    const { status } = await parseJsonResponse(await post({ mode: 'everything' }))
    expect(status).toBe(400)
  })

  it('returns 404 when the order is missing', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(404)
    expect(body.error.code).toBe('SALES_ORDER_NOT_FOUND')
  })

  it('returns 409 SALES_ORDER_INVALID_STATE for a draft order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_INVALID_STATE')
  })

  it('returns 409 SALES_ORDER_OVER_INVOICED for a pick above the remaining quantity', async () => {
    enqueue({ data: confirmed() })
    enqueue({ data: [invoicedRow(IDS.item1, 7)] })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, unknown> } }>(
      await post({ lines: [{ sales_order_item_id: IDS.item1, quantity: 4 }] }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_OVER_INVOICED')
    expect(body.error.details).toMatchObject({ remaining_qty: 3, requested_qty: 4 })
    expect(mockBuildInvoiceWriteData).not.toHaveBeenCalled()
  })

  it('returns 409 SALES_ORDER_NOTHING_TO_INVOICE when everything is invoiced', async () => {
    enqueue({ data: confirmed() })
    enqueue({ data: [invoicedRow(IDS.item1, 10)] })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_NOTHING_TO_INVOICE')
  })

  it('creates the draft, links it to the order and answers 201 with invoice_id', async () => {
    const emitted: string[] = []
    eventBus.on('invoice.created', async () => {
      emitted.push('invoice.created')
    })

    enqueue({ data: confirmed() })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.invoice, status: 'draft', invoice_number: null, sales_order_id: IDS.order } })
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: confirmed() }) // reload
    enqueue({ data: [invoicedRow(IDS.item1, 10)] })

    const { status, body } = await parseJsonResponse<{
      data: { invoice: Invoice; order: SalesOrder }
      invoice_id: string
    }>(await post({ invoice_date: '2026-09-02' }))

    expect(status).toBe(201)
    expect(body.invoice_id).toBe(IDS.invoice)
    expect(body.data.invoice.id).toBe(IDS.invoice)
    expect(body.data.order.invoicing_progress).toBe('full')

    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(expect.objectContaining({ documentType: 'invoice' }))
    const invoiceInsert = findCall('invoices', 'insert')![0] as Record<string, unknown>
    expect(invoiceInsert).toMatchObject({ sales_order_id: IDS.order, invoice_number: null, status: 'draft' })
    const itemRows = findCall('invoice_items', 'insert')![0] as Record<string, unknown>[]
    expect(itemRows[0]).toMatchObject({ invoice_id: IDS.invoice, sales_order_item_id: IDS.item1 })
    expect(emitted).toEqual(['invoice.created'])
  })

  it('rolls the draft back and answers 409 when the over-invoice trigger fires', async () => {
    enqueue({ data: confirmed() })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.invoice, status: 'draft' } })
    enqueue({ data: null, error: { message: 'SALES_ORDER_OVER_INVOICED: exceeds ordered', code: 'P0001' } })
    enqueue({ data: null })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_OVER_INVOICED')
    expect(findCall('invoices', 'delete')).toBeDefined()
  })
})
