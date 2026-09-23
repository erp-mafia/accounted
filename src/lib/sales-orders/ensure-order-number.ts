import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Assign OR-<n> to a sales order via the generate_sales_order_number RPC.
 * Idempotent (an already numbered order returns its number without
 * consuming the counter) and concurrency-safe inside the RPC (row lock on
 * the order + atomic counter on company_settings). Mirrors
 * lib/articles/ensure-article-number.ts; orders are not verifikationer, so
 * a gap is harmless.
 */
export async function ensureSalesOrderNumber(
  supabase: SupabaseClient,
  companyId: string,
  orderId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('generate_sales_order_number', {
    p_company_id: companyId,
    p_order_id: orderId,
  })
  if (error || !data) {
    throw new Error(`Failed to assign sales order number: ${error?.message ?? 'no value returned'}`)
  }
  return data as string
}
