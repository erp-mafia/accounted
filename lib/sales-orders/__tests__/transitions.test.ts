/**
 * transitionSalesOrder: the header state machine (confirm / cancel / reopen)
 * with the queued Supabase mock.
 *
 * Queue order per loadSalesOrder: from('sales_orders') select, then
 * rpc('sales_order_invoiced_quantities'). hasOpenInvoices adds one more
 * rpc call and, when no line carries invoiced quantity, a from('invoices')
 * head count.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { transitionSalesOrder } from '../transitions'
import { IDS, invoicedRow, makeSalesOrder, makeSalesOrderItem } from './fixtures'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const sb = supabase as unknown as SupabaseClient

describe('transitionSalesOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('returns SALES_ORDER_NOT_FOUND when the order does not exist', async () => {
    enqueue({ data: null })
    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'confirm' })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_NOT_FOUND' })
  })

  it('refuses a transition from a state the action does not allow', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [] })

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'confirm' })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALES_ORDER_INVALID_STATE',
      details: { status: 'confirmed', action: 'confirm' },
    })
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('refuses reopen of a draft (only cancelled orders reopen)', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'reopen' })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_INVALID_STATE' })
  })

  it('refuses cancel while a linked invoice carries invoiced quantity', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [invoicedRow(IDS.item1, '2')] }) // load
    enqueue({ data: [invoicedRow(IDS.item1, '2')] }) // hasOpenInvoices

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'cancel' })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_HAS_INVOICES' })
    expect(findCall('sales_orders', 'update')).toBeUndefined()
  })

  it('refuses cancel while a header-linked invoice exists even with zero invoiced quantity', async () => {
    enqueue({ data: makeSalesOrder({ status: 'confirmed' }) })
    enqueue({ data: [] }) // load: nothing invoiced per line
    enqueue({ data: [] }) // hasOpenInvoices rpc: nothing per line
    enqueue({ data: null, count: 1 }) // invoices head count: one open invoice

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'cancel' })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_HAS_INVOICES' })
    expect(findCall('invoices', 'select')).toBeDefined()
  })

  it('refuses confirm when the order has no customer', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft', customer_id: null, customer: null }) })
    enqueue({ data: [] })
    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'confirm' })
    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_CUSTOMER_MISSING' })
  })

  it('confirms a draft: sets confirmed_at, compare-and-sets on status, refreshes completion', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: [{ id: IDS.order }] }) // CAS update matched one row
    enqueue({ data: null }) // refresh_sales_order_completion
    enqueue({ data: makeSalesOrder({ status: 'confirmed', confirmed_at: '2026-09-02T10:00:00Z' }) })
    enqueue({ data: [] })

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'confirm' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order.status).toBe('confirmed')
    expect(result.order.delivery_progress).toBe('none')
    expect(result.order.invoicing_progress).toBe('none')

    const patch = findCall('sales_orders', 'update')![0] as Record<string, unknown>
    expect(patch.status).toBe('confirmed')
    expect(typeof patch.confirmed_at).toBe('string')
    expect(() => new Date(patch.confirmed_at as string).toISOString()).not.toThrow()
    // Compare-and-set on the status that was read.
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['status', 'draft'])
    expect(supabase.rpc).toHaveBeenCalledWith('refresh_sales_order_completion', { p_order_id: IDS.order })
  })

  it('reports SALES_ORDER_INVALID_STATE when the compare-and-set matches no row (lost race)', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: [] }) // CAS update matched nothing

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'confirm' })

    expect(result).toMatchObject({ ok: false, code: 'SALES_ORDER_INVALID_STATE' })
    expect(supabase.rpc).not.toHaveBeenCalledWith('refresh_sales_order_completion', expect.anything())
  })

  it('cancels a draft with no invoices and stamps cancelled_at', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: [] }) // hasOpenInvoices rpc
    enqueue({ data: null, count: 0 }) // no header-linked invoices
    enqueue({ data: [{ id: IDS.order }] })
    enqueue({ data: makeSalesOrder({ status: 'cancelled', cancelled_at: '2026-09-02T10:00:00Z' }) })
    enqueue({ data: [] })

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'cancel' })

    expect(result.ok).toBe(true)
    const patch = findCall('sales_orders', 'update')![0] as Record<string, unknown>
    expect(patch.status).toBe('cancelled')
    expect(typeof patch.cancelled_at).toBe('string')
    expect(supabase.rpc).not.toHaveBeenCalledWith('refresh_sales_order_completion', expect.anything())
  })

  it('reopens a cancelled order back to draft and clears every timestamp', async () => {
    enqueue({
      data: makeSalesOrder({
        status: 'cancelled',
        cancelled_at: '2026-09-02T10:00:00Z',
        confirmed_at: '2026-09-01T10:00:00Z',
        items: [makeSalesOrderItem()],
      }),
    })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null, count: 0 })
    enqueue({ data: [{ id: IDS.order }] })
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'reopen' })

    expect(result.ok).toBe(true)
    expect(findCall('sales_orders', 'update')![0]).toEqual({
      status: 'draft',
      cancelled_at: null,
      confirmed_at: null,
      completed_at: null,
    })
  })

  it('surfaces a DB error from the update as a dbError failure', async () => {
    enqueue({ data: makeSalesOrder({ status: 'draft' }) })
    enqueue({ data: [] })
    enqueue({ data: null, error: { message: 'connection reset', code: '08006' } })

    const result = await transitionSalesOrder(sb, { companyId: IDS.company, orderId: IDS.order, action: 'confirm' })

    expect(result.ok).toBe(false)
    expect('dbError' in result && result.dbError).toMatchObject({ message: 'connection reset' })
  })
})
