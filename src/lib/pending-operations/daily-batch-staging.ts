import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * What the daily batches share: the collections batch
 * (collections_daily_batch, lib/collections/autopilot.ts) and the reminder
 * batch (reminder_daily_batch, lib/reminders/gather.ts). Each is ONE staged
 * pending operation per company and day that a person reviews in Att göra;
 * a batch nobody decided on is withdrawn after three days, and it is staged
 * under a member of the company (pending_operations.user_id is NOT NULL).
 */

/** A daily run rejects its own batch once it has waited this long (the generic expiry waits 30 days). */
export const DAILY_BATCH_EXPIRY_HOURS = 72

/**
 * How much earlier than DAILY_BATCH_EXPIRY_HOURS after its staging a daily
 * run may reject a batch. The cron fires once a day and stages the batch
 * during its run, so the third run after it can start seconds short of 72
 * hours; without this slack the batch would wait for the fourth (96 hours).
 */
export const DAILY_BATCH_EXPIRY_RUN_SLACK_MS = 60 * 60_000

/**
 * Reject the pending batches of one type that have waited
 * DAILY_BATCH_EXPIRY_HOURS (less the run slack): one company's (companyId),
 * or every company's (null, a cron's sweep). Returns how many were rejected.
 */
export async function expireStaleDailyBatches(
  db: Pick<SupabaseClient, 'from'>,
  operationType: string,
  companyId: string | null,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - DAILY_BATCH_EXPIRY_HOURS * 3_600_000 + DAILY_BATCH_EXPIRY_RUN_SLACK_MS).toISOString()
  let query = db
    .from('pending_operations')
    .update({
      status: 'rejected',
      resolved_at: now.toISOString(),
      // A system rejection says so (20261012070931): nobody judged the batch.
      rejection_category: 'expired',
      result_data: { auto_rejected: true, reason: 'expired' },
    })
    .eq('operation_type', operationType)
    .eq('status', 'pending')
    .lt('created_at', cutoff)
  if (companyId !== null) query = query.eq('company_id', companyId)
  const { data, error } = await query.select('id')
  if (error) throw new Error(`${operationType} expiry failed: ${error.message}`)
  return (data ?? []).length
}

/**
 * Who a batch is staged under: the preferred member (who turned the
 * feature on) while still a member, else the company's owner. Approval is a
 * separate question (an owner or administrator).
 */
export async function resolveDailyBatchOwner(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  preferredUserId: string | null,
): Promise<string | null> {
  const { data, error } = await db.from('company_members').select('user_id, role').eq('company_id', companyId)
  if (error) throw new Error(`company_members lookup failed: ${error.message}`)
  const members = (data ?? []) as Array<{ user_id: string; role: string }>
  if (preferredUserId && members.some((m) => m.user_id === preferredUserId)) return preferredUserId
  return members.find((m) => m.role === 'owner')?.user_id ?? null
}
