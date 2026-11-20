/**
 * The company's own portals (public.company_portals), read once per request
 * by every reader that resolves a purchase's portal: the Inkorg's purchases
 * and expectations, and Kvittojakten's worklist (./company-portals.ts holds
 * the rule).
 *
 * A failed read answers no company portals rather than failing the reader:
 * the directory still answers, and a list without the company's own links is
 * better than no list at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { CompanyPortal } from './company-portals'

const log = createLogger('receipt-hunt/company-portals')

export async function readCompanyPortals(supabase: SupabaseClient, companyId: string): Promise<CompanyPortal[]> {
  try {
    return await fetchAllRows<CompanyPortal>(({ from, to }) =>
      supabase
        .from('company_portals')
        .select('id, counterparty_key, vendor_name, url')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch (err) {
    log.warn('company portals read failed: directory only', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}
