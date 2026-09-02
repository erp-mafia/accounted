import type { SupabaseClient } from '@supabase/supabase-js'
import type { SalesOrder, SalesOrderItem } from '@/types'
import { maskEmbeddedCustomer } from '@/lib/customers/protect-personal-number'
import { deliveryProgress, invoicingProgress, withInvoicedQuantities } from './progress'
import { fail, failDb, type ServiceResult } from './result'

/**
 * Invoiced quantity per order line for a set of orders, from the
 * SECURITY INVOKER RPC (RLS applies). Returns an empty map for no ids.
 */
export async function fetchInvoicedQuantities(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<{ ok: true; byItem: Map<string, number> } | { ok: false; dbError: unknown }> {
  if (orderIds.length === 0) return { ok: true, byItem: new Map() }
  const { data, error } = await supabase.rpc('sales_order_invoiced_quantities', {
    p_order_ids: orderIds,
  })
  if (error) return { ok: false, dbError: error }
  const byItem = new Map<string, number>()
  for (const row of (data ?? []) as Array<{ sales_order_item_id: string; invoiced_qty: number | string }>) {
    byItem.set(row.sales_order_item_id, Number(row.invoiced_qty))
  }
  return { ok: true, byItem }
}

/**
 * One order with its customer (masked), its lines in sort order, the
 * derived invoiced/remaining quantities and both progress axes.
 */
export async function loadSalesOrder(
  supabase: SupabaseClient,
  companyId: string,
  orderId: string,
): Promise<ServiceResult<{ order: SalesOrder }>> {
  const { data, error } = await supabase
    .from('sales_orders')
    .select('*, customer:customers(*), items:sales_order_items(*)')
    .eq('id', orderId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return failDb(error)
  if (!data) return fail('SALES_ORDER_NOT_FOUND')

  const invoiced = await fetchInvoicedQuantities(supabase, [orderId])
  if (!invoiced.ok) return failDb(invoiced.dbError)

  return { ok: true, order: decorate(maskEmbeddedCustomer(data as SalesOrder), invoiced.byItem) }
}

export function decorate(order: SalesOrder, invoiced: Map<string, number>): SalesOrder {
  const items = withInvoicedQuantities(
    [...((order.items ?? []) as SalesOrderItem[])].sort((a, b) => a.sort_order - b.sort_order),
    invoiced,
  )
  return {
    ...order,
    items,
    delivery_progress: deliveryProgress(items),
    invoicing_progress: invoicingProgress(items),
  }
}
