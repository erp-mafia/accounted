import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { SalesOrder } from '@/types'
import type { RegisterSalesOrderDeliverySchema } from '@/lib/api/schemas'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { loadSalesOrder } from './load'
import { qtyGreater } from './progress'
import { codeFromPgError, fail, failDb, type ServiceResult } from './result'

export type RegisterDeliveryInput = z.infer<typeof RegisterSalesOrderDeliverySchema>

/**
 * Register delivered quantities on a confirmed (or already fully invoiced)
 * order. Quantities are CUMULATIVE (the new delivered_qty), so a retried
 * request is idempotent and the dialog can show the running total.
 *
 * Every line whose delivered quantity increases records the delivery date
 * as its own last_delivery_date; the header's last_delivery_date is the
 * latest across lines and is display-only. Invoices created afterwards take
 * the delivery date from the lines they cover (ML 17 kap 24 § p.7, and the
 * FX anchor per ML 8 kap 21-23 §), never from the header.
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
  const deliveryDate = input.delivery_date ?? todayIsoStockholm()
  const increased = new Set<string>()
  for (const line of input.lines) {
    const item = items.get(line.sales_order_item_id)
    if (!item) return fail('SALES_ORDER_LINE_NOT_FOUND', { sales_order_item_id: line.sales_order_item_id })
    if (item.line_type === 'text') continue
    if (qtyGreater(line.delivered_qty, item.quantity)) {
      return fail('SALES_ORDER_OVER_DELIVERED', {
        sales_order_item_id: item.id,
        quantity: item.quantity,
        delivered_qty: line.delivered_qty,
      })
    }
    if (qtyGreater(line.delivered_qty, item.delivered_qty)) increased.add(item.id)
  }

  for (const line of input.lines) {
    const item = items.get(line.sales_order_item_id)
    if (!item || item.line_type === 'text') continue
    // Optimistic predicate on the quantity read above: two concurrent
    // cumulative registrations (6 and 8 from 0) must not let the later
    // write regress the earlier one.
    const { data: updated, error } = await supabase
      .from('sales_order_items')
      .update({
        delivered_qty: line.delivered_qty,
        last_delivery_date: increased.has(item.id) ? deliveryDate : undefined,
      })
      .eq('id', item.id)
      .eq('company_id', companyId)
      .eq('delivered_qty', item.delivered_qty)
      .select('id')
    if (error) {
      const code = codeFromPgError(error)
      return code ? fail(code) : failDb(error)
    }
    if (!updated || updated.length === 0) {
      return fail('SALES_ORDER_INVALID_STATE', {
        action: 'deliver',
        sales_order_item_id: item.id,
        reason: 'delivered quantity changed concurrently',
      })
    }
  }

  if (increased.size > 0) {
    const { error } = await supabase
      .from('sales_orders')
      .update({ last_delivery_date: deliveryDate })
      .eq('id', orderId)
      .eq('company_id', companyId)
    if (error) return failDb(error)
  }

  return loadSalesOrder(supabase, companyId, orderId)
}
