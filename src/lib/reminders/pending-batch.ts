import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { REMINDER_BATCH_ITEM_KIND, REMINDER_BATCH_TYPE, type ReminderBatchItem } from './batch'
import { reminderRunItems } from './batch-dialog'

/**
 * The company's pending daily reminder batch, read the one way the Att göra
 * count (lib/worklist reminder_batch_ready) and the row that opens its
 * dialog both use, on the session or the browser client: at most one batch
 * is pending, and its items are the staged ones less those a person took
 * out (collection_batch_removals rows of kind 'reminder'). RLS scopes both
 * tables to members; the company filter is defense in depth. Never reads
 * event_log.
 */

export interface PendingReminderBatch {
  id: string
  /** The items still in the batch. */
  items: ReminderBatchItem[]
}

export type PendingReminderBatchRead =
  | { ok: true; batch: PendingReminderBatch | null }
  | { ok: false; error: { message?: string } }

export async function readPendingReminderBatch(supabase: SupabaseDataClient, companyId: string): Promise<PendingReminderBatchRead> {
  const ops = await supabase
    .from('pending_operations')
    .select('id, params')
    .eq('company_id', companyId)
    .eq('operation_type', REMINDER_BATCH_TYPE)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
  if (ops.error) return { ok: false, error: ops.error }
  const op = (ops.data ?? [])[0] as { id: string; params: unknown } | undefined
  if (!op) return { ok: true, batch: null }
  // Nothing staged: nothing to take out either.
  if (reminderRunItems(op.params).length === 0) return { ok: true, batch: { id: op.id, items: [] } }

  const removals = await supabase
    .from('collection_batch_removals')
    .select('invoice_id')
    .eq('company_id', companyId)
    .eq('pending_operation_id', op.id)
    .eq('kind', REMINDER_BATCH_ITEM_KIND)
  // Without the removals the batch cannot be counted: a wrong number is worse than none.
  if (removals.error) return { ok: false, error: removals.error }
  const removed = ((removals.data ?? []) as Array<{ invoice_id: string }>).map((row) => row.invoice_id)
  return { ok: true, batch: { id: op.id, items: reminderRunItems(op.params, removed) } }
}
