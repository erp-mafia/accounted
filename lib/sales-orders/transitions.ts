import type { SupabaseClient } from '@supabase/supabase-js'
import type { SalesOrder, SalesOrderStatus } from '@/types'
import { loadSalesOrder } from './load'
import { hasOpenInvoices } from './write'
import { fail, failDb, type ServiceResult } from './result'

export type SalesOrderTransition = 'confirm' | 'cancel' | 'reopen'

/**
 * Header state machine. `completed` is never set here: it is maintained by
 * the DB (refresh_sales_order_completion) from the derived invoiced
 * quantities, and flips back to `confirmed` when a linked invoice is
 * cancelled or credited.
 *
 *   draft      -confirm-> confirmed
 *   draft      -cancel--> cancelled
 *   confirmed  -cancel--> cancelled   (refused while linked invoices exist)
 *   cancelled  -reopen--> draft       (refused while linked invoices exist)
 */
const ALLOWED: Record<SalesOrderTransition, { from: SalesOrderStatus[]; to: SalesOrderStatus }> = {
  confirm: { from: ['draft'], to: 'confirmed' },
  cancel: { from: ['draft', 'confirmed'], to: 'cancelled' },
  reopen: { from: ['cancelled'], to: 'draft' },
}

export async function transitionSalesOrder(
  supabase: SupabaseClient,
  params: { companyId: string; orderId: string; action: SalesOrderTransition },
): Promise<ServiceResult<{ order: SalesOrder }>> {
  const { companyId, orderId, action } = params
  const current = await loadSalesOrder(supabase, companyId, orderId)
  if (!current.ok) return current
  const order = current.order
  const rule = ALLOWED[action]
  if (!rule.from.includes(order.status)) {
    return fail('SALES_ORDER_INVALID_STATE', { status: order.status, action })
  }

  if (action === 'cancel' || action === 'reopen') {
    const open = await hasOpenInvoices(supabase, companyId, orderId)
    if (!open.ok) return failDb(open.dbError)
    if (open.open) return fail('SALES_ORDER_HAS_INVOICES')
  }
  if (action === 'confirm' && !order.customer_id) return fail('SALES_ORDER_CUSTOMER_MISSING')

  const patch: Record<string, unknown> = { status: rule.to }
  if (action === 'confirm') patch.confirmed_at = new Date().toISOString()
  if (action === 'cancel') patch.cancelled_at = new Date().toISOString()
  if (action === 'reopen') {
    patch.cancelled_at = null
    patch.confirmed_at = null
    patch.completed_at = null
  }

  // Compare-and-set on the status read above so two concurrent transitions
  // cannot both win.
  const { data: updated, error } = await supabase
    .from('sales_orders')
    .update(patch)
    .eq('id', orderId)
    .eq('company_id', companyId)
    .eq('status', order.status)
    .select('id')
  if (error) return failDb(error)
  if (!updated || updated.length === 0) return fail('SALES_ORDER_INVALID_STATE', { status: order.status, action })

  if (action === 'confirm') {
    // Hand-linked invoice lines may already cover the order: let the DB
    // evaluate completion right away instead of waiting for the next line
    // change. Best effort; the triggers keep it honest afterwards.
    await supabase.rpc('refresh_sales_order_completion', { p_order_id: orderId })
  }

  return loadSalesOrder(supabase, companyId, orderId)
}
