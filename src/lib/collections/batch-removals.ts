import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { BatchRemoval } from './batch'

/**
 * The items an owner or administrator took out of a pending daily
 * collections or reminder batch (collection_batch_removals, written only by
 * remove_collection_batch_items). Read by the commits and the review route.
 * Paged: a removal past PostgREST's 1000 rows would otherwise go unread, and
 * its item be sent anyway. Server only; no event-emitting imports.
 */
export async function loadBatchRemovals(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  operationId: string,
): Promise<Array<BatchRemoval & { removed_by: string; removed_at: string }>> {
  try {
    return await fetchAllRows<BatchRemoval & { removed_by: string; removed_at: string }>((range) =>
      db
        .from('collection_batch_removals')
        .select('invoice_id, kind, removed_by, removed_at')
        .eq('company_id', companyId)
        .eq('pending_operation_id', operationId)
        .order('removed_at', { ascending: true })
        .order('id', { ascending: true })
        .range(range.from, range.to),
    )
  } catch (error) {
    throw new Error(`collection_batch_removals lookup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
