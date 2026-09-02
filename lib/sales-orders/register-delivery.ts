import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { SalesOrder } from '@/types'
import type { RegisterSalesOrderDeliverySchema } from '@/lib/api/schemas'
import { loadSalesOrder } from './load'
import { codeFromPgError, fail, failDb, type ServiceResult } from './result'

export type RegisterDeliveryInput = z.infer<typeof RegisterSalesOrderDeliverySchema>

/**
 * Register delivered quantities on a confirmed (or already fully invoiced)
 * order. Quantities are CUMULATIVE (the new delivered_qty), so a retried
 * request is idempotent and the dialog can show the running total. The
 * order's last_delivery_date moves forward when any line's delivered
 * quantity increases; invoices created from the order afterwards use it as
 * their delivery_date (taxable event, ML 8 kap 21-23 §).
 *
 * There is no inventory: delivery is a fact the user records, nothing is
 * booked.
 */
export async function registerSalesOrderDelivery(
  supabase: SupabaseClient,
  params: { companyId: string; orderId: string; input: RegisterDeliveryInput },
): Promise<ServiceResult<{ order: SalesOrder }>> {
  const { companyId, orderId, input } = params
  const current = await loadSalesOrder(supabase, companyId, orderId)
  if (!current.ok) return current
  const order = current.order
  if (order.status !== 'confirmed' && order.status !== 'completed') {
    return fail('SALES_ORDER_INVALID_STATE', { status: order.status, action: 'deliver' })
  }

  const items = new Map((order.items ?? []).map((i) => [i.id, i]))
  let increased = false
  for (const line of input.lines) {
    const item = items.get(line.sales_order_item_id)
    if (!item) return fail('SALES_ORDER_LINE_NOT_FOUND', { sales_order_item_id: line.sales_order_item_id })
    if (item.line_type === 'text') continue
    if (line.delivered_qty > item.quantity) {
      return fail('SALES_ORDER_OVER_DELIVERED', {
        sales_order_item_id: item.id,
        quantity: item.quantity,
        delivered_qty: line.delivered_qty,
      })
    }
    if (line.delivered_qty > item.delivered_qty) increased = true
  }

  for (const line of input.lines) {
    const item = items.get(line.sales_order_item_id)
    if (!item || item.line_type === 'text') continue
    const { error } = await supabase
      .from('sales_order_items')
      .update({ delivered_qty: line.delivered_qty })
      .eq('id', item.id)
      .eq('company_id', companyId)
    if (error) {
      const code = codeFromPgError(error)
      return code ? fail(code) : failDb(error)
    }
  }

  if (increased) {
    const deliveryDate = input.delivery_date ?? new Date().toISOString().slice(0, 10)
    const { error } = await supabase
      .from('sales_orders')
      .update({ last_delivery_date: deliveryDate })
      .eq('id', orderId)
      .eq('company_id', companyId)
    if (error) return failDb(error)
  }

  return loadSalesOrder(supabase, companyId, orderId)
}
