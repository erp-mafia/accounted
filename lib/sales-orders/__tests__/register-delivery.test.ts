/**
 * registerSalesOrderDelivery: cumulative delivered quantities on a
 * confirmed order, over-delivery guard, last_delivery_date bump.
 *
 * Queue order: loadSalesOrder (sales_orders select, invoiced rpc), one
 * sales_order_items update per product line, an optional sales_orders
 * update when any quantity increased, then loadSalesOrder again.
 *
 * Each line update is an optimistic write (.eq('delivered_qty', previous)
 * + .select('id')): the queued result must carry the matched row, since an
 * empty array or null now means the quantity moved concurrently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { registerSalesOrderDelivery } from '../register-delivery'
import { IDS, makeSalesOrder, makeSalesOrderItem } from './fixtures'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const sb = supabase as unknown as SupabaseClient

function confirmedOrder(items = [makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 0 })]) {
  return makeSalesOrder({ status: 'confirmed', confirmed_at: '2026-09-01T10:00:00Z', items })
}

/** The matched-row result of a successful optimistic line update. */
const matched = (id: string) => ({ data: [{ id }] })

describe('registerSalesOrderDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  afterEach(() => {
    vi.useRealTimers()
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
    enqueue(matched(IDS.item1)) // sales_order_items update
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
    // The line that increased records the delivery date as its own
    // last_delivery_date: invoices later take leveransdatum from the lines.
    expect(findCall('sales_order_items', 'update')![0]).toEqual({
      delivered_qty: 6,
      last_delivery_date: '2026-09-02',
    })
    expect(findCalls('sales_order_items', 'eq')).toContainEqual(['id', IDS.item1])
    expect(findCalls('sales_order_items', 'eq')).toContainEqual(['company_id', IDS.company])
    // Optimistic predicate on the quantity read before the write.
    expect(findCalls('sales_order_items', 'eq')).toContainEqual(['delivered_qty', 2])
    expect(findCall('sales_order_items', 'select')).toEqual(['id'])
    expect(findCall('sales_orders', 'update')![0]).toEqual({ last_delivery_date: '2026-09-02' })
  })

  it('defaults the delivery date to today in Europe/Stockholm when none is given', async () => {
    // 22:30 UTC on 30 June is already 1 July in Stockholm (CEST, UTC+2).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T22:30:00Z'))
    enqueue({ data: confirmedOrder() })
    enqueue({ data: [] })
    enqueue(matched(IDS.item1))
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
    expect(patch.last_delivery_date).toBe('2026-07-01')
    expect(findCall('sales_order_items', 'update')![0]).toEqual({
      delivered_qty: 3,
      last_delivery_date: '2026-07-01',
    })
  })

  it('returns SALES_ORDER_INVALID_STATE when a line update matches zero rows (concurrent registration)', async () => {
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 0 })]) })
    enqueue({ data: [] })
    enqueue({ data: [] }) // sales_order_items update: delivered_qty no longer 0, nothing matched

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { delivery_date: '2026-09-02', lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 6 }] },
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_INVALID_STATE',
      details: {
        action: 'deliver',
        sales_order_item_id: IDS.item1,
        reason: 'delivered quantity changed concurrently',
      },
    })
    expect(findCalls('sales_order_items', 'eq')).toContainEqual(['delivered_qty', 0])
    // The header is never stamped when a line refused the write.
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('treats a null update result as the same concurrency conflict', async () => {
    enqueue({ data: confirmedOrder() })
    enqueue({ data: [] })
    enqueue({ data: null }) // sales_order_items update

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 1 }] },
    })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_INVALID_STATE' })
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('does not move last_delivery_date when no quantity increased (idempotent retry)', async () => {
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 6 })]) })
    enqueue({ data: [] })
    enqueue(matched(IDS.item1)) // sales_order_items update (same value)
    enqueue({ data: confirmedOrder([makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 6 })]) })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: { delivery_date: '2026-09-05', lines: [{ sales_order_item_id: IDS.item1, delivered_qty: 6 }] },
    })

    expect(result.ok).toBe(true)
    // The line is still written (cumulative value), but its last_delivery_date
    // is left untouched: undefined drops out of the PostgREST payload.
    const lineUpdate = findCall('sales_order_items', 'update')![0] as Record<string, unknown>
    expect(lineUpdate).toEqual({ delivered_qty: 6, last_delivery_date: undefined })
    expect(lineUpdate.last_delivery_date).toBeUndefined()
    expect(findCalls('sales_order_items', 'eq')).toContainEqual(['delivered_qty', 6])
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('stamps last_delivery_date only on the lines that increased in a mixed delivery', async () => {
    enqueue({
      data: confirmedOrder([
        makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 4, last_delivery_date: '2026-08-20' }),
        makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 5, delivered_qty: 1 }),
      ]),
    })
    enqueue({ data: [] })
    enqueue(matched(IDS.item1)) // item1 update (unchanged quantity)
    enqueue(matched(IDS.item2)) // item2 update (increased)
    enqueue({ data: null }) // header update
    enqueue({
      data: confirmedOrder([
        makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 4 }),
        makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 5, delivered_qty: 3 }),
      ]),
    })
    enqueue({ data: [] })

    const result = await registerSalesOrderDelivery(sb, {
      companyId: IDS.company,
      orderId: IDS.order,
      input: {
        delivery_date: '2026-09-03',
        lines: [
          { sales_order_item_id: IDS.item1, delivered_qty: 4 },
          { sales_order_item_id: IDS.item2, delivered_qty: 3 },
        ],
      },
    })

    expect(result.ok).toBe(true)
    const updates = findCalls('sales_order_items', 'update').map((args) => args[0])
    expect(updates).toEqual([
      { delivered_qty: 4, last_delivery_date: undefined },
      { delivered_qty: 3, last_delivery_date: '2026-09-03' },
    ])
    expect((updates[0] as Record<string, unknown>).last_delivery_date).toBeUndefined()
    expect(findCall('sales_orders', 'update')![0]).toEqual({ last_delivery_date: '2026-09-03' })
  })

  it('skips text rows without writing them', async () => {
    enqueue({
      data: confirmedOrder([
        makeSalesOrderItem({ id: IDS.item1, line_type: 'text', quantity: 0, delivered_qty: 0 }),
        makeSalesOrderItem({ id: IDS.item2, sort_order: 1, quantity: 4, delivered_qty: 0 }),
      ]),
    })
    enqueue({ data: [] })
    enqueue(matched(IDS.item2)) // item2 update
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
