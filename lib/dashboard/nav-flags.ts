import type { SupabaseClient } from '@supabase/supabase-js'

export interface DashboardNavFlags {
  /** An active WooCommerce/Shopify connection or already-imported webshop orders. */
  hasWebshop: boolean
  /** Existing mileage trips (created via UI, API or MCP). */
  hasMileageTrips: boolean
}

const FALLBACK_CODES = new Set(['PGRST202', '42883', '42501'])

/**
 * The two booleans that gate the Webshop and Körjournal nav rows, in one
 * round trip via get_dashboard_nav_flags() (migration 20260826120000).
 *
 * Fallback to the four limit-1 probes the layout ran before the RPC when
 * the function is not deployed yet (self-hosted instance not migrated, or
 * the deploy-ordering window before the branching merge applies the
 * migration) or EXECUTE is not granted: mirrors the load-bearing fallback
 * in lib/company/context.ts. Any other error degrades to (false, false):
 * these flags only hide nav rows, they are never load-bearing.
 */
export async function getDashboardNavFlags(
  supabase: SupabaseClient,
  companyId: string,
): Promise<DashboardNavFlags> {
  const rpc = await supabase.rpc('get_dashboard_nav_flags', { p_company_id: companyId })
  if (!rpc.error) {
    const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as
      | { has_webshop?: boolean | null; has_mileage_trips?: boolean | null }
      | null
      | undefined
    return {
      hasWebshop: row?.has_webshop === true,
      hasMileageTrips: row?.has_mileage_trips === true,
    }
  }
  if (!FALLBACK_CODES.has(rpc.error.code ?? '')) {
    return { hasWebshop: false, hasMileageTrips: false }
  }
  return getDashboardNavFlagsViaProbes(supabase, companyId)
}

/** The pre-RPC implementation, kept verbatim as the fallback. */
export async function getDashboardNavFlagsViaProbes(
  supabase: SupabaseClient,
  companyId: string,
): Promise<DashboardNavFlags> {
  const [woo, shopify, orders, trips] = await Promise.all([
    supabase.from('woocommerce_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1),
    supabase.from('shopify_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1),
    supabase.from('webshop_orders').select('id').eq('company_id', companyId).limit(1),
    supabase.from('mileage_trips').select('id').eq('company_id', companyId).limit(1),
  ])
  return {
    hasWebshop:
      (woo.data?.length ?? 0) > 0 || (shopify.data?.length ?? 0) > 0 || (orders.data?.length ?? 0) > 0,
    hasMileageTrips: (trips.data?.length ?? 0) > 0,
  }
}
