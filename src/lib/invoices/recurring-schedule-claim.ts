import type { SupabaseClient } from '@supabase/supabase-js'

/** The columns a run claim reads and writes. */
export interface ClaimableSchedule {
  id: string
  company_id: string
  last_run_at: string | null
}

/**
 * Claim one run of a recurring schedule: compare-and-set last_run_at from the
 * value that was read to `claimTs`. Postgres row locking serialises two
 * writers, so only the one whose WHERE still matches the old value flips the
 * row and gets it back; the loser matches zero rows and must not spawn an
 * invoice. The hourly cron and "Skapa faktura nu" both claim through this, so
 * two crons, two clicks or a click during the cron never create two invoices
 * for one run (accounted#58). Throws when the write itself fails.
 */
export async function claimRecurringScheduleRun(
  supabase: SupabaseClient,
  schedule: ClaimableSchedule,
  claimTs: string,
): Promise<boolean> {
  const base = supabase
    .from('recurring_invoice_schedules')
    .update({ last_run_at: claimTs })
    .eq('id', schedule.id)
    .eq('company_id', schedule.company_id)
  const gated = schedule.last_run_at ? base.eq('last_run_at', schedule.last_run_at) : base.is('last_run_at', null)
  const { data, error } = await gated.select('id')
  if (error) throw new Error(`failed to claim recurring schedule run: ${error.message}`)
  return Array.isArray(data) && data.length > 0
}

/**
 * Give a claim back after the run failed: restore the last_run_at that was
 * read, only while the row still holds this claim, plus whatever the caller
 * records about the failure. Best effort: the caller is already answering the
 * failure, and a claim left in place only delays the next run.
 */
export async function releaseRecurringScheduleRun(
  supabase: SupabaseClient,
  schedule: ClaimableSchedule,
  claimTs: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await supabase
    .from('recurring_invoice_schedules')
    .update({ last_run_at: schedule.last_run_at, ...extra })
    .eq('id', schedule.id)
    .eq('company_id', schedule.company_id)
    .eq('last_run_at', claimTs)
}
