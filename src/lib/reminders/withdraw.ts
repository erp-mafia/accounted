import type { SupabaseClient } from '@supabase/supabase-js'
import { REMINDER_BATCH_TYPE } from './batch'

/**
 * Turning reminders off withdraws the company's pending daily batch at once
 * (accounted#104): it can no longer be approved (reminderBatchApprovalRefusal
 * answers REMINDERS_OFF), so it should not wait in Att göra until the next
 * reminder cron. The row is the one the cron writes for a company that has
 * turned reminders off (gather.ts, withdrawBatchesOfCompaniesTurnedOff):
 * rejected by the system, superseded, reason reminders_off. The cron's sweep
 * stays behind it for a withdrawal that fails here.
 *
 * Withdraws the company's pending reminder batch (at most one); returns how
 * many went.
 */
export async function withdrawPendingReminderBatches(db: Pick<SupabaseClient, 'from'>, companyId: string, now: Date): Promise<number> {
  const { data, error } = await db
    .from('pending_operations')
    .update({
      status: 'rejected',
      rejection_category: 'superseded',
      result_data: { auto_rejected: true, reason: 'reminders_off' },
      resolved_at: now.toISOString(),
    })
    .eq('company_id', companyId)
    .eq('operation_type', REMINDER_BATCH_TYPE)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`reminder batch withdrawal failed: ${error.message}`)
  return (data ?? []).length
}
