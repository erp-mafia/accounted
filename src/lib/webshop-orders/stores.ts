import type { SupabaseClient } from '@supabase/supabase-js'
import type { WebshopPlatform } from '@/types'
import { WebshopPlatformSchema } from '@/lib/api/schemas'
import { createLogger } from '@/lib/logger'

const log = createLogger('webshop-stores')

export interface WebshopStore {
  platform: WebshopPlatform
  store_scope: string
  store_label: string | null
}

/**
 * Loop bound, not a cap anyone should meet: a company runs a handful of
 * stores. It only stops a read that cannot advance from spinning forever.
 */
const MAX_STORES_PER_PLATFORM = 500

/**
 * The stores a company has orders from, for the Orders page's store filter.
 *
 * A distinct over (platform, store_scope), read as a loose index scan on
 * idx_webshop_orders_company_store: per platform, one single-row read per
 * store, each asking for the first store_scope after the last one seen. The
 * cost follows the number of stores, never the number of orders. The list
 * used to be read off order rows under a 5,000-row limit, which PostgREST
 * answers with the first 1,000 rows: a store whose orders all sat past them
 * never reached the dropdown.
 *
 * Throws the PostgREST error of a failed read.
 */
export async function listWebshopStores(supabase: SupabaseClient, companyId: string): Promise<WebshopStore[]> {
  const perPlatform = await Promise.all(
    WebshopPlatformSchema.options.map(async (platform) => {
      const stores: WebshopStore[] = []
      let after: string | null = null
      while (stores.length < MAX_STORES_PER_PLATFORM) {
        let query = supabase
          .from('webshop_orders')
          .select('platform, store_scope, store_label')
          .eq('company_id', companyId)
          .eq('platform', platform)
          .eq('row_type', 'order')
        if (after !== null) query = query.gt('store_scope', after)
        const { data, error } = await query.order('store_scope', { ascending: true }).limit(1).maybeSingle()
        if (error) throw error
        if (!data) return stores
        const row = data as WebshopStore
        stores.push({ platform: row.platform, store_scope: row.store_scope, store_label: row.store_label })
        after = row.store_scope
      }
      log.warn('store list stopped at the loop bound', { companyId, platform, bound: MAX_STORES_PER_PLATFORM })
      return stores
    }),
  )
  return perPlatform
    .flat()
    .sort((a, b) => (a.store_scope < b.store_scope ? -1 : a.store_scope > b.store_scope ? 1 : a.platform < b.platform ? -1 : 1))
}
