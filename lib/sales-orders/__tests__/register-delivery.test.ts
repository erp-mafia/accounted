/**
 * registerSalesOrderDelivery: cumulative delivered quantities on a
 * confirmed order, over-delivery guard, last_delivery_date bump.
 *
 * Queue order: loadSalesOrder (sales_orders select, invoiced rpc), one
 * sales_order_items update per product line, an optional sales_orders
 * update when any quantity increased, then loadSalesOrder again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { registerSalesOrderDelivery } from '../register-delivery'
import { IDS, makeSalesOrder, makeSalesOrderItem } from './fixtures'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const sb = supabase as unknown as SupabaseClient

function confirmedOrder(items = [makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 0 })]) {
  return makeSalesOrder({ status: 'confirmed', confirmed_at: '2026-09-01T10:00:00Z', items })
}

describe('registerSalesOrderDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('returns SALES_ORDER_NOT_FOUND for a missing order', async () => {
    enqueue({ data: null })
    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] },
    })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_NOT_FOUND' })
  })

  it('refuses delivery on an order that is not confirmed', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] },
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_INVALID_STATE',
      details: { status: 'draft', action: 'deliver' },
    })
    expect(findCall('sales_order_items', 'update')).toBeUndefined()
  })

  it('refuses delivery on a cancelled order', async () => {
    enqueue({ data: makeSalesOrder({ status: 'cancelled' }) })
    enqueue({ data: [] })
    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] },
    })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_INVALID_STATE' })
  })

  it('refuses delivering more than the ordered quantity before touching any line', async () => {
    enqueue({
      data: confirmedOrder([
        makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 0 }),
        makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 5, delivered_qty: 0 }),
      ]),
    })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: {
        lines: [
          { sales_order_item_id: IDS.item1, delivered_qty: 10 },
          { sales_order_item_id: IDS.item2, delivered_qty: 6 },
        ],
      },
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_OVER_DELIVERED',
      details: { sales_order_item_id: IDS.item2, quantity: 5, delivered_qty: 6 },
    })
    // Validation runs over every line first: the valid first line is not written either.
    expect(findCall('sales_order_items', 'update')).toBeUndefined()
  })

  it('refuses a line id that is not on the order', async () => {
    enqueue({ data: confirmedOrder() })
    enqueue({ data: [] })
    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { lines: [{ sales_order_item_id: IDS.unknownItem, delivered_qty: 1 }] },
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_LINE_NOT_FOUND',
      details: { sales_order_item_id: IDS.unknownItem },
    })
  })

  it('writes the cumulative quantity and moves last_delivery_date when a quantity increased', async () => {
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 2 })]) })
    enqueue({ data: [] })
    enqueue({ data: null }) // sales_order_items update
    enqueue({ data: null }) // sales_orders update (last_delivery_date)
    enqueue({
      data: confirmedOrder([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 6 })]),
    })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { delivery_date: '2026-09-02', lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 6 }] },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order.delivery_progress).toBe('partial')
    expect(findCall('sales_order_items', 'update')![0]).toEqual({ delivered_qty: 6 })
    expect(findCalls('sales_order_items', 'eq')).toContainEqual(['id', IDS.item1])
    expect(findCalls('sales_order_items', 'eq')).toContainEqual(['company_id', IDS.company])
    expect(findCall('sales_orders', 'update')![0]).toEqual({ last_delivery_date: '2026-09-02' })
  })

  it('defaults the delivery date to today when none is given', async () => {
    enqueue({ data: confirmedOrder() })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ delivered_qty: 3 })]) })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 3 }] },
    })

    expect(result.ok).toBe(true)
    const patch = findCall('sales_orders', 'update')![0] as { last_delivery_date: string }
    expect(patch.last_delivery_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('does not move last_delivery_date when no quantity increased (idempotent retry)', async () => {
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 6 })]) })
    enqueue({ data: [] })
    enqueue({ data: null }) // sales_order_items update (same value)
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 6 })]) })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { delivery_date: '2026-09-05', lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 6 }] },
    })

    expect(result.ok).toBe(true)
    expect(findCall('sales_order_items', 'update')).toBeDefined()
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('skips text rows without writing them', async () => {
    enqueue({
      data: confirmedOrder([
        makeSalesOrderItem({ id: IDS.item1, line_type: 'text', quantity: 0, delivered_qty: 0 }),
        makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 4, delivered_qty: 0 }),
      ]),
    })
    enqueue({ data: [] })
    enqueue({ data: null }) // item2 update
    enqueue({ data: null }) // header update
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ id: IDS.item2, quantity: 4, delivered_qty: 4 })]) })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: {
        lines: [
          { sales_order_item_id: IDS.item1, delivered_qty: 99 },
          { sales_order_item_id: IDS.item2, delivered_qty: 4 },
        ],
      },
    })

    expect(result.ok).toBe(true)
    expect(findCalls('sales_order_items', 'update')).toHaveLength(1)
    expect(findCalls('sales_order_items', 'eq')).not.toContainEqual(['id', IDS.item1])
  })

  it('maps the delivered-within-ordered DB constraint onto SALES_ORDER_OVER_DELIVERED', async () => {
    enqueue({ data: confirmedOrder() })
    enqueue({ data: [] })
    enqueue({
      data: null,
      error: { message: 'new row violates check constraint "sales_order_items_delivered_within_ordered"' },
    })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 5 }] },
    })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_OVER_DELIVERED' })
  })
})
