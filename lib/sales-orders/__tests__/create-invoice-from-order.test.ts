/**
 * pickLines (pure) and createInvoiceFromSalesOrder (queued mock, with the
 * invoice builder mocked).
 *
 * createInvoiceFromSalesOrder queue order: loadSalesOrder (sales_orders
 * select, invoiced rpc), customers select, invoices insert, invoice_items
 * insert, then loadSalesOrder again. On an items-insert failure the two
 * rollback deletes (invoice_items, invoices) come before the failure returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { IDS, invoicedRow, makeOrderCustomer, makeSalesOrder, makeSalesOrderItem } from './fixtures'

const mockBuildInvoiceWriteData = vi.fn()
vi.mock('@/lib/invoices/build-invoice-write', () => ({
  buildInvoiceWriteData: (...args: unknown[]) => mockBuildInvoiceWriteData(...args),
}))

import { createInvoiceFromSalesOrder, pickLines } from '../create-invoice-from-order'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const sb = supabase as unknown as SupabaseClient

function orderWith(items = [makeSalesOrderItem()], overrides = {}) {
  return makeSalesOrder({ status: 'confirmed', confirmed_at: '2026-09-01T10:00:00Z', items, ...overrides })
}

describe('pickLines', () => {
  const order = makeSalesOrder({
    items: [
      makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 5, invoiced_qty: 2, remaining_qty: 8 }),
      makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 4, delivered_qty: 0, invoiced_qty: 4, remaining_qty: 0 }),
      makeSalesOrderItem({ id: IDS.item3, sort_order: 2, line_type: 'text', quantity: 0, delivered_qty: 0 }),
    ],
  })

  it('refuses an explicit pick above the remaining quantity', () => {
    const result = pickLines(order, { lines: [{ sales_order_item_id: IDS.item1, quantity: 9 }] })
    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_OVER_INVOICED',
      details: { sales_order_item_id: IDS.item1, remaining_qty: 8, requested_qty: 9 },
    })
  })

  it('accepts an explicit pick at exactly the remaining quantity', () => {
    const result = pickLines(order, { lines: [{ sales_order_item_id: IDS.item1, quantity: 8 }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.picked).toHaveLength(1)
    expect(result.picked[0]).toMatchObject({ quantity: 8, item: { id: IDS.item1 } })
  })

  it('derives remaining from quantity - invoiced_qty when remaining_qty is absent', () => {
    const bare = makeSalesOrder({ items: [makeSalesOrderItem({ id: IDS.item1, quantity: 10, invoiced_qty: 7 })] })
    expect(pickLines(bare, { lines: [{ sales_order_item_id: IDS.item1, quantity: 4 }] })).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_OVER_INVOICED',
      details: { remaining_qty: 3 },
    })
  })

  it('refuses an explicit pick of a text row or an unknown line', () => {
    expect(pickLines(order, { lines: [{ sales_order_item_id: IDS.item3, quantity: 1 }] })).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_LINE_NOT_FOUND',
    })
    expect(pickLines(order, { lines: [{ sales_order_item_id: IDS.unknownItem, quantity: 1 }] })).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_LINE_NOT_FOUND',
      details: { sales_order_item_id: IDS.unknownItem },
    })
  })

  it('mode remaining (default) picks everything not yet invoiced', () => {
    const result = pickLines(order, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // item2 is fully invoiced, the text row never counts.
    expect(result.picked.map((p) => [p.item.id, p.quantity])).toEqual([[IDS.item1, 8]])
  })

  it('mode delivered picks delivered minus invoiced, capped at remaining', () => {
    const result = pickLines(order, { mode: 'delivered' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // item1: delivered 5 - invoiced 2 = 3
    expect(result.picked.map((p) => [p.item.id, p.quantity])).toEqual([[IDS.item1, 3]])
  })

  it('mode delivered never goes negative when more is invoiced than delivered', () => {
    const advance = makeSalesOrder({
      items: [
        makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 1, invoiced_qty: 5 }),
        makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 10, delivered_qty: 6, invoiced_qty: 5 }),
      ],
    })
    const result = pickLines(advance, { mode: 'delivered' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.picked.map((p) => [p.item.id, p.quantity])).toEqual([[IDS.item2, 1]])
  })

  it('returns SALES_ORDER_NOTHING_TO_INVOICE when every line is fully invoiced', () => {
    const done = makeSalesOrder({
      items: [makeSalesOrderItem({ id: IDS.item1, quantity: 4, invoiced_qty: 4, remaining_qty: 0 })],
    })
    expect(pickLines(done, {})).toMatchObject({ ok: false, code: 'SALES_ORDER_NOTHING_TO_INVOICE' })
    expect(pickLines(done, { mode: 'delivered' })).toMatchObject({ ok: false, code: 'SALES_ORDER_NOTHING_TO_INVOICE' })
  })

  it('returns SALES_ORDER_NOTHING_TO_INVOICE in delivered mode when nothing was delivered', () => {
    const undelivered = makeSalesOrder({ items: [makeSalesOrderItem({ quantity: 4, delivered_qty: 0 })] })
    expect(pickLines(undelivered, { mode: 'delivered' })).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_NOTHING_TO_INVOICE',
    })
  })

  it('treats an empty explicit lines array like no picks', () => {
    const result = pickLines(order, { lines: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.picked.map((p) => p.item.id)).toEqual([IDS.item1])
  })
})

const okBuild = {
  ok: true,
  invoiceFields: {
    customer_id: IDS.customer,
    invoice_date: '2026-09-02',
    due_date: '2026-10-02',
    currency: 'SEK',
    subtotal: 800,
    vat_amount: 200,
    total: 1000,
    vat_treatment: 'standard_25',
  },
  items: [
    {
      sort_order: 0,
      line_type: 'product',
      description: 'Konsulttimme',
      quantity: 8,
      unit: 'h',
      unit_price: 100,
      line_total: 800,
      vat_rate: 25,
      vat_amount: 200,
      sales_order_item_id: IDS.item1,
    },
  ],
}

describe('createInvoiceFromSalesOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
  })

  const params = { companyId: IDS.company, userId: IDS.user, orderId: IDS.order }

  it('returns SALES_ORDER_NOT_FOUND for a missing order', async () => {
    enqueue({ data: null })
    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: {} })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_NOT_FOUND' })
    expect(mockBuildInvoiceWriteData).not.toHaveBeenCalled()
  })

  it('refuses invoicing an order that is not confirmed', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: {} })
    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_INVALID_STATE',
      details: { status: 'draft', action: 'invoice' },
    })
    expect(mockBuildInvoiceWriteData).not.toHaveBeenCalled()
  })

  it('refuses when nothing remains to invoice', async () => {
    enqueue({ data: orderWith([makeSalesOrderItem({ id: IDS.item1, quantity: 4 })]) })
    enqueue({ data: [invoicedRow(IDS.item1, 4)] })
    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: {} })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_NOTHING_TO_INVOICE' })
    expect(findCall('invoices', 'insert')).toBeUndefined()
  })

  it('returns CUSTOMER_NOT_FOUND when the raw customer row is gone', async () => {
    enqueue({ data: orderWith() })
    enqueue({ data: [] })
    enqueue({ data: null })
    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: {} })
    expect(result).toMatchObject({ ok: false, code: 'CUSTOMER_NOT_FOUND', details: { customerId: IDS.customer } })
  })

  it('creates an unnumbered draft linked to the order, each line carrying its sales_order_item_id', async () => {
    enqueue({
      data: orderWith(
        [
          makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 0, discount_percent: 10 }),
          makeSalesOrderItem({ id: IDS.item3, sort_order: 1, line_type: 'text', description: 'Tack', quantity: 0 }),
        ],
        { order_number: 'OR-7', your_reference: 'Anna', last_delivery_date: '2026-08-30' },
      ),
    })
    enqueue({ data: [invoicedRow(IDS.item1, 2)] })
    enqueue({ data: makeOrderCustomer({ default_payment_terms: 20 }) })
    enqueue({ data: { id: IDS.invoice, status: 'draft', invoice_number: null, sales_order_id: IDS.order } })
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: orderWith() }) // reload
    enqueue({ data: [invoicedRow(IDS.item1, 10)] })

    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: { invoice_date: '2026-09-02' } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoice.id).toBe(IDS.invoice)
    expect(result.order.invoicing_progress).toBe('full')

    // Builder input: the remaining 8 of item1, the text row carried along,
    // sales_order_item_id on the product line, due date from customer terms,
    // no delivery date because nothing was delivered.
    const buildArg = mockBuildInvoiceWriteData.mock.calls[0][0] as {
      documentType: string
      input: { items: Record<string, unknown>[]; due_date: string; delivery_date: unknown; notes?: string; your_reference?: string }
    }
    expect(buildArg.documentType).toBe('invoice')
    expect(buildArg.input.due_date).toBe('2026-09-22')
    expect(buildArg.input.delivery_date).toBeNull()
    expect(buildArg.input.notes).toBe('Kundorder OR-7')
    expect(buildArg.input.your_reference).toBe('Anna')
    expect(buildArg.input.items).toEqual([
      expect.objectContaining({
        line_type: 'product',
        quantity: 8,
        unit_price: 100,
        discount_percent: 10,
        vat_rate: 25,
        sales_order_item_id: IDS.item1,
      }),
      expect.objectContaining({ line_type: 'text', description: 'Tack', quantity: 0 }),
    ])

    const invoiceInsert = findCall('invoices', 'insert')![0] as Record<string, unknown>
    expect(invoiceInsert).toMatchObject({
      user_id: IDS.user,
      company_id: IDS.company,
      invoice_number: null,
      status: 'draft',
      sales_order_id: IDS.order,
      subtotal: 800,
      total: 1000,
    })

    const itemRows = findCall('invoice_items', 'insert')![0] as Record<string, unknown>[]
    expect(itemRows).toHaveLength(1)
    for (const row of itemRows) {
      expect(row.invoice_id).toBe(IDS.invoice)
      expect(row.sales_order_item_id).toBe(IDS.item1)
    }
    expect(findCall('invoices', 'delete')).toBeUndefined()
  })

  it('sets delivery_date from the order when a picked line has been delivered', async () => {
    enqueue({
      data: orderWith([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 4 })], {
        last_delivery_date: '2026-08-30',
      }),
    })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.invoice, status: 'draft' } })
    enqueue({ data: null })
    enqueue({ data: orderWith() })
    enqueue({ data: [] })

    const result = await createInvoiceFromSalesOrder(sb, {
      ...params,
      input: { mode: 'delivered', due_date: '2026-09-30' },
    })

    expect(result.ok).toBe(true)
    const buildArg = mockBuildInvoiceWriteData.mock.calls[0][0] as { input: { delivery_date: unknown; due_date: string; items: { quantity: number }[] } }
    expect(buildArg.input.delivery_date).toBe('2026-08-30')
    expect(buildArg.input.due_date).toBe('2026-09-30')
    expect(buildArg.input.items[0].quantity).toBe(4)
  })

  it('propagates a builder domain failure without inserting', async () => {
    enqueue({ data: orderWith() })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    mockBuildInvoiceWriteData.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
      details: { attemptedRate: 25 },
    })

    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: {} })

    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREATE_VAT_RULE_VIOLATION', details: { attemptedRate: 25 } })
    expect(findCall('invoices', 'insert')).toBeUndefined()
  })

  it('deletes the draft and maps the over-invoice trigger when the line insert fails', async () => {
    enqueue({ data: orderWith() })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.invoice, status: 'draft' } })
    enqueue({
      data: null,
      error: { message: 'SALES_ORDER_OVER_INVOICED: line d1000000 would exceed ordered quantity', code: 'P0001' },
    })
    enqueue({ data: null }) // invoice_items delete
    enqueue({ data: null }) // invoices delete

    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: {} })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_OVER_INVOICED' })
    expect(findCall('invoice_items', 'delete')).toBeDefined()
    expect(findCall('invoice_items', 'eq')).toEqual(['invoice_id', IDS.invoice])
    expect(findCall('invoices', 'delete')).toBeDefined()
    expect(findCall('invoices', 'eq')).toEqual(['id', IDS.invoice])
  })

  it('deletes the draft and returns the raw DB error when the line insert fails for another reason', async () => {
    enqueue({ data: orderWith() })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.invoice, status: 'draft' } })
    enqueue({ data: null, error: { message: 'null value in column "description"', code: '23502' } })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = await createInvoiceFromSalesOrder(sb, { ...params, input: {} })

    expect(result.ok).toBe(false)
    expect('dbError' in result && result.dbError).toMatchObject({ code: '23502' })
    expect(findCall('invoices', 'delete')).toBeDefined()
  })
})
