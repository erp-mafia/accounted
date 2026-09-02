/**
 * createSalesOrder / updateSalesOrder with the queued Supabase mock.
 *
 * updateSalesOrder queue order: loadSalesOrder (sales_orders select,
 * invoiced rpc), then ONLY when customer_id or currency changes:
 * hasOpenInvoices (invoiced rpc, and an invoices head count when no line
 * carries invoiced quantity), then customers select, sales_orders update,
 * then when lines are given: sales_order_items delete (only if any
 * dropped), one sales_order_items update per kept line, one insert for new
 * lines, and a final loadSalesOrder.
 *
 * The header update is an object literal with every column present (an
 * omitted input leaves undefined, which PostgREST drops), so assertions use
 * toMatchObject and check the untouched keys are undefined explicitly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createSalesOrder, hasOpenInvoices, updateSalesOrder } from '../write'
import { IDS, invoicedRow, makeOrderCustomer, makeSalesOrder, makeSalesOrderItem } from './fixtures'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const sb = supabase as unknown as SupabaseClient

const baseLine = { description: 'Konsulttimme', quantity: 10, unit: 'h', unit_price: 100, vat_rate: 25 }

describe('updateSalesOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('returns SALES_ORDER_NOT_FOUND for a missing order', async () => {
    enqueue({ data: null })
    const result = await updateSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, input: { notes: 'x' } })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_NOT_FOUND' })
  })

  it('refuses edits on a completed order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'completed', completed_at: '2026-09-02T10:00:00Z' }) })
    enqueue({ data: [invoicedRow(IDS.item1, 10)] })

    const result = await updateSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, input: { notes: 'Sen' } })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_NOT_EDITABLE', details: { status: 'completed' } })
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('refuses edits on a cancelled order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'cancelled' }) })
    enqueue({ data: [] })
    const result = await updateSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, input: { notes: 'Sen' } })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_NOT_EDITABLE' })
  })

  it('refuses dropping a line that has invoiced quantity', async () => {
    enqueue({
      data: makeSalesOrder({
        status: 'confirmed',
        items: [
          makeSalesOrderItem({ id: IDS.item1, quantity: 10 }),
          makeSalesOrderItem({ id: IDS.item2, sort_order: 1, description: 'Licens', quantity: 2 }),
        ],
      }),
    })
    enqueue({ data: [invoicedRow(IDS.item1, 3)] })
    enqueue({ data: makeOrderCustomer() })

    // Only item2 comes back: item1 (3 invoiced) would be deleted.
    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { items: [{ id: IDS.item2, ...baseLine, description: 'Licens', quantity: 2 }] },
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_LINE_LOCKED',
      details: { sales_order_item_id: IDS.item1 },
    })
    expect(findCall('sales_orders', 'update')).toBeUndefined()
    expect(findCall('sales_order_items', 'delete')).toBeUndefined()
  })

  it('refuses dropping a line that has delivered quantity', async () => {
    enqueue({
      data: makeSalesOrder({
        status: 'confirmed',
        items: [
          makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 1 }),
          makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 2 }),
        ],
      }),
    })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { items: [{ id: IDS.item2, ...baseLine, quantity: 2 }] },
    })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_LINE_LOCKED' })
  })

  it('refuses lowering a line below its delivered quantity', async () => {
    enqueue({
      data: makeSalesOrder({
        status: 'confirmed',
        items: [makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 5 })],
      }),
    })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { items: [{ id: IDS.item1, ...baseLine, quantity: 3 }] },
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_OVER_DELIVERED',
      details: { sales_order_item_id: IDS.item1, delivered_qty: 5 },
    })
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('refuses lowering a line below its invoiced quantity', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed', items: [makeSalesOrderItem({ id: IDS.item1, quantity: 10 })] }) })
    enqueue({ data: [invoicedRow(IDS.item1, 4)] })
    enqueue({ data: makeOrderCustomer() })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { items: [{ id: IDS.item1, ...baseLine, quantity: 3 }] },
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_QUANTITY_BELOW_INVOICED',
      details: { sales_order_item_id: IDS.item1, invoiced_qty: 4 },
    })
  })

  it('refuses a line id that does not belong to the order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { items: [{ id: IDS.unknownItem, ...baseLine }] },
    })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_LINE_NOT_FOUND' })
  })

  it('returns CUSTOMER_NOT_FOUND when the new customer is not in the company', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: null })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { customer_id: IDS.otherCustomer },
    })

    expect(result).toMatchObject({ ok: false, code: 'CUSTOMER_NOT_FOUND' })
  })

  it('re-validates stored lines when only the customer changes (25 % line to a validated EU business)', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft', items: [makeSalesOrderItem({ vat_rate: 25 })] }) })
    enqueue({ data: [] })
    enqueue({ data: [] }) // hasOpenInvoices: invoiced rpc (nothing invoiced)
    enqueue({ data: null, count: 0 }) // hasOpenInvoices: no header-linked invoice
    enqueue({
      data: makeOrderCustomer({
        id: IDS.otherCustomer,
        customer_type: 'eu_business',
        vat_number: 'DE123456789',
        vat_number_validated: true,
      }),
    })
    enqueue({ data: null }) // header update
    enqueue({ data: makeSalesOrder({ status: 'draft', customer_id: IDS.otherCustomer }) })
    enqueue({ data: [] })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { customer_id: IDS.otherCustomer },
    })

    // 25 % is permitted for a validated EU business (taxed where performed),
    // so the customer change goes through and only the header is written,
    // with the snapshot refreshed to the NEW customer's VAT facts.
    expect(result.ok).toBe(true)
    expect(findCall('sales_orders', 'update')![0]).toMatchObject({
      customer_id: IDS.otherCustomer,
      customer_type_snapshot: 'eu_business',
      customer_vat_validated_snapshot: true,
    })
    expect(findCall('sales_order_items', 'update')).toBeUndefined()
    expect(findCalls('invoices', 'eq')).toContainEqual(['sales_order_id', IDS.order])
  })

  it('refuses a customer change with SALES_ORDER_HAS_INVOICES once a line has invoiced quantity', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed', items: [makeSalesOrderItem({ id: IDS.item1 })] }) })
    enqueue({ data: [invoicedRow(IDS.item1, 2)] }) // loadSalesOrder
    enqueue({ data: [invoicedRow(IDS.item1, 2)] }) // hasOpenInvoices rpc

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { customer_id: IDS.otherCustomer, notes: 'Byt kund' },
    })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_HAS_INVOICES', details: { field: 'customer_id' } })
    // The check runs before the customer is even loaded and nothing is written.
    expect(findCall('customers', 'select')).toBeUndefined()
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('refuses a currency change when a header-linked invoice exists even with zero invoiced quantity', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [] })
    enqueue({ data: [] }) // hasOpenInvoices rpc: nothing invoiced
    enqueue({ data: null, count: 1 }) // but an invoice still points at the order

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { currency: 'EUR' },
    })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_HAS_INVOICES', details: { field: 'currency' } })
    expect(findCall('customers', 'select')).toBeUndefined()
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('skips the open-invoice check when customer_id and currency are unchanged', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [invoicedRow(IDS.item1, 2)] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: null }) // header update
    enqueue({ data: makeSalesOrder({ status: 'confirmed', notes: 'Samma kund' }) })
    enqueue({ data: [invoicedRow(IDS.item1, 2)] })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { customer_id: IDS.customer, currency: 'SEK', notes: 'Samma kund' },
    })

    expect(result.ok).toBe(true)
    // Two rpc calls: the two loadSalesOrder calls, no hasOpenInvoices in between.
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(findCall('invoices', 'select')).toBeUndefined()
  })

  it('updates header only when no lines are given, keeping stored totals', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft', subtotal: 1000, vat_amount: 250, total: 1250 }) })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: null }) // header update
    enqueue({ data: makeSalesOrder({ status: 'draft', notes: 'Leverans till lagret' }) })
    enqueue({ data: [] })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { notes: 'Leverans till lagret', requested_delivery_date: '2026-09-15' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order.notes).toBe('Leverans till lagret')
    const headerUpdate = findCall('sales_orders', 'update')![0] as Record<string, unknown>
    expect(headerUpdate).toMatchObject({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      notes: 'Leverans till lagret',
      requested_delivery_date: '2026-09-15',
      customer_type_snapshot: 'swedish_business',
      customer_vat_validated_snapshot: false,
    })
    // Omitted inputs stay undefined so PostgREST leaves the columns alone.
    for (const key of ['customer_id', 'currency', 'order_date', 'your_reference', 'our_reference', 'default_dimensions']) {
      expect(headerUpdate).toHaveProperty(key)
      expect(headerUpdate[key]).toBeUndefined()
    }
    expect(findCall('sales_order_items', 'update')).toBeUndefined()
    expect(findCall('sales_order_items', 'insert')).toBeUndefined()
  })

  it('replaces lines: updates kept lines by id, inserts new ones, deletes omitted ones, recomputes totals', async () => {
    enqueue({
      data: makeSalesOrder({
        status: 'confirmed',
        items: [
          makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 2 }),
          makeSalesOrderItem({ id: IDS.item2, sort_order: 1, description: 'Bortplockad', quantity: 1 }),
        ],
      }),
    })
    enqueue({ data: [] })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: null }) // header update
    enqueue({ data: null }) // delete item2
    enqueue({ data: null }) // update item1
    enqueue({ data: null }) // insert new line
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [] })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: {
        items: [
          { id: IDS.item1, ...baseLine, quantity: 12 },
          { description: 'Resa', quantity: 1, unit: 'st', unit_price: 500, vat_rate: 6 },
        ],
      },
    })

    expect(result.ok).toBe(true)
    // 12 x 100 @ 25 % + 500 @ 6 %
    const headerUpdate = findCall('sales_orders', 'update')![0] as Record<string, unknown>
    expect(headerUpdate).toMatchObject({
      subtotal: 1700,
      vat_amount: 330,
      total: 2030,
      customer_type_snapshot: 'swedish_business',
      customer_vat_validated_snapshot: false,
    })
    expect(headerUpdate.customer_id).toBeUndefined()
    expect(headerUpdate.notes).toBeUndefined()
    expect(findCall('sales_order_items', 'in')).toEqual(['id', [IDS.item2]])
    const lineUpdate = findCall('sales_order_items', 'update')![0] as Record<string, unknown>
    expect(lineUpdate).toMatchObject({ quantity: 12, sort_order: 0, line_total: 1200 })
    expect(lineUpdate).not.toHaveProperty('id')
    const inserted = findCall('sales_order_items', 'insert')![0] as Record<string, unknown>[]
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      description: 'Resa',
      sort_order: 1,
      vat_rate: 6,
      line_total: 500,
      company_id: IDS.company,
      sales_order_id: IDS.order,
    })
    expect(inserted[0]).not.toHaveProperty('id')
  })

  it('maps the quantity-below-invoiced trigger onto SALES_ORDER_QUANTITY_BELOW_INVOICED (race)', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [] }) // pre-check sees nothing invoiced
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: null }) // header update
    enqueue({ data: null, error: { message: 'SALES_ORDER_QUANTITY_BELOW_INVOICED: line d1 has 4 invoiced' } })

    const result = await updateSalesOrder(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { items: [{ id: IDS.item1, ...baseLine, quantity: 3 }] },
    })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_QUANTITY_BELOW_INVOICED' })
  })
})

describe('createSalesOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('returns CUSTOMER_NOT_FOUND when the customer is not in the company', async () => {
    enqueue({ data: null })
    const result = await createSalesOrder(sb, {
      companyId: IDS.company,
      userId: IDS.user,
      input: { customer_id: IDS.customer, items: [baseLine] },
    })
    expect(result).toMatchObject({ ok: false, code: 'CUSTOMER_NOT_FOUND', details: { customerId: IDS.customer } })
    expect(findCall('sales_orders', 'insert')).toBeUndefined()
  })

  it('propagates the VAT gate before any insert', async () => {
    enqueue({ data: makeOrderCustomer({ customer_type: 'non_eu_business' }) })
    const result = await createSalesOrder(sb, {
      companyId: IDS.company,
      userId: IDS.user,
      input: { customer_id: IDS.customer, items: [{ ...baseLine, vat_rate: 20 }] },
    })
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREATE_VAT_RULE_VIOLATION' })
    expect(findCall('sales_orders', 'insert')).toBeUndefined()
  })

  it('inserts header + lines, numbers the order and reloads it', async () => {
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.order } }) // header insert
    enqueue({ data: null }) // items insert
    enqueue({ data: 'OR-1' }) // generate_sales_order_number
    enqueue({ data: makeSalesOrder({ status: 'draft', order_number: 'OR-1' }) })
    enqueue({ data: [] })

    const result = await createSalesOrder(sb, {
      companyId: IDS.company,
      userId: IDS.user,
      input: {
        customer_id: IDS.customer,
        order_date: '2026-09-01',
        items: [baseLine, { line_type: 'text', description: 'Tack för din order', quantity: 0, unit: '', unit_price: 0 }],
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order.order_number).toBe('OR-1')
    expect(findCall('sales_orders', 'insert')![0]).toMatchObject({
      company_id: IDS.company,
      user_id: IDS.user,
      customer_id: IDS.customer,
      status: 'draft',
      source_invoice_id: null,
      order_date: '2026-09-01',
      currency: 'SEK',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      // The customer facts the lines were VAT-validated under travel with the order.
      customer_type_snapshot: 'swedish_business',
      customer_vat_validated_snapshot: false,
    })
    const lines = findCall('sales_order_items', 'insert')![0] as Record<string, unknown>[]
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ sales_order_id: IDS.order, company_id: IDS.company, line_type: 'product' })
    expect(lines[1]).toMatchObject({ line_type: 'text', quantity: 0, line_total: 0 })
    expect(supabase.rpc).toHaveBeenCalledWith('generate_sales_order_number', {
      p_company_id: IDS.company,
      p_order_id: IDS.order,
    })
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['id', IDS.order])
  })

  it('rolls the header back when the line insert fails', async () => {
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.order } })
    enqueue({ data: null, error: { message: 'insert failed', code: '23502' } })
    enqueue({ data: null }) // header delete

    const result = await createSalesOrder(sb, {
      companyId: IDS.company,
      userId: IDS.user,
      input: { customer_id: IDS.customer, items: [baseLine] },
    })

    expect(result.ok).toBe(false)
    expect('dbError' in result).toBe(true)
    expect(findCall('sales_orders', 'delete')).toBeDefined()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('still returns the order when numbering fails (number assigned on the next write)', async () => {
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.order } })
    enqueue({ data: null })
    enqueue({ data: null, error: { message: 'counter locked' } }) // rpc fails
    enqueue({ data: makeSalesOrder({ status: 'draft', order_number: null }) })
    enqueue({ data: [] })

    const result = await createSalesOrder(sb, {
      companyId: IDS.company,
      userId: IDS.user,
      input: { customer_id: IDS.customer, items: [baseLine] },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order.order_number).toBeNull()
  })
})

describe('hasOpenInvoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('is open as soon as any line carries invoiced quantity (no header count needed)', async () => {
    enqueue({ data: [invoicedRow(IDS.item1, '1')] })
    const result = await hasOpenInvoices(sb, IDS.company, IDS.order)
    expect(result).toEqual({ ok: true, open: true })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('falls back to a header count when no line is invoiced', async () => {
    enqueue({ data: [] })
    enqueue({ data: null, count: 0 })
    const result = await hasOpenInvoices(sb, IDS.company, IDS.order)
    expect(result).toEqual({ ok: true, open: false })
    expect(findCalls('invoices', 'eq')).toContainEqual(['sales_order_id', IDS.order])
  })
})
