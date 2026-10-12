import type { SupabaseClient } from '@supabase/supabase-js'
import type { BatchRemoval } from './batch'

/**
 * The items an owner or administrator took out of a pending daily
 * collections batch (collection_batch_removals, written only by
 * remove_collection_batch_items). Read by the commit and the review route.
 * Server only; no event-emitting imports.
 */
export async function loadBatchRemovals(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  operationId: string,
): Promise<Array<BatchRemoval & { removed_by: string; removed_at: string }>> {
  const { data, error } = await db
    .from('collection_batch_removals')
    .select('invoice_id, kind, removed_by, removed_at')
    .eq('company_id', companyId)
    .eq('pending_operation_id', operationId)
    .order('removed_at', { ascending: true })
  if (error) throw new Error(`collection_batch_removals lookup failed: ${error.message}`)
  return (data ?? []) as Array<BatchRemoval & { removed_by: string; removed_at: string }>
}

