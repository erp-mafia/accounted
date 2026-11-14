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
 * for one run (accounted#58). That holds only while the run's own writes move
 * last_run_at off its claim: the cron's record writes a token of its own, so
 * a claim from the cron's claim token, read before that record, matches
 * nothing after it (accounted#211). `extra` is written in the same UPDATE
 * (the cron writes the warning a person reads if its run never finishes).
 * Throws when the write itself fails.
 */
export async function claimRecurringScheduleRun(
  supabase: SupabaseClient,
  schedule: ClaimableSchedule,
  claimTs: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const base = supabase
    .from('recurring_invoice_schedules')
    .update({ last_run_at: claimTs, ...extra })
    .eq('id', schedule.id)
    .eq('company_id', schedule.company_id)
  const gated = schedule.last_run_at ? base.eq('last_run_at', schedule.last_run_at) : base.is('last_run_at', null)
  const { data, error } = await gated.select('id')
  if (error) throw new Error(`failed to claim recurring schedule run: ${error.message}`)
  return Array.isArray(data) && data.length > 0
}

/**
 * Give a claim back after the run failed: restore the last_run_at that was
 * read, only while the row still holds `heldTs` (the claim, or the hold that
 * replaced it), plus whatever the caller records about the failure. Answers
 * whether a row was released; false also when the write failed, which leaves
 * the schedule held: never free beside a draft the run may have left (the
 * cron's claim and hold carry the warning that asks a person to step in).
 */
export async function releaseRecurringScheduleRun(
  supabase: SupabaseClient,
  schedule: ClaimableSchedule,
  heldTs: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const { data, error } = await supabase
    .from('recurring_invoice_schedules')
    .update({ last_run_at: schedule.last_run_at, ...extra })
    .eq('id', schedule.id)
    .eq('company_id', schedule.company_id)
    .eq('last_run_at', heldTs)
    .select('id')
  return !error && Array.isArray(data) && data.length > 0
}

/**
 * Hold a run whose record on the schedule may have landed unseen (a transport
 * error after the UPDATE was sent): move the claim on to `holdTs` and write
 * `warning`, the one a person reads, only while this run holds the claim. The
 * record is gated on the claim too and moves last_run_at on to a token of its
 * own, so of the two UPDATEs whichever commits first wins and the other
 * matches no row. The hold keeps the schedule claimed: until a release from
 * `holdTs` lands, every run passes it by (the same day as already run, from
 * the next day as held for a person).
 *
 * Answers 'held' when it matched (the record never landed and now never
 * will), 'moved' when it matched no row (the record landed, or another run
 * holds the claim), 'unknown' when the write itself failed (it may have
 * landed; the claim, or the hold, stays either way).
 */
export async function holdRecurringScheduleRun(
  supabase: SupabaseClient,
  schedule: ClaimableSchedule,
  claimTs: string,
  holdTs: string,
  warning: string,
): Promise<'held' | 'moved' | 'unknown'> {
  const { data, error } = await supabase
    .from('recurring_invoice_schedules')
    .update({ last_run_at: holdTs, last_run_warning: warning })
    .eq('id', schedule.id)
    .eq('company_id', schedule.company_id)
    .eq('last_run_at', claimTs)
    .select('id')
  if (error) return 'unknown'
  return Array.isArray(data) && data.length > 0 ? 'held' : 'moved'
}

/**
 * Whether the schedule names `invoiceId` as its last invoice: the read-back
 * after a record whose answer was an error and whose hold did not take the
 * run. The id is the run's own draft's, and only the run's record writes it
 * on the schedule, so finding it proves that record landed. False also when
 * the read fails: nobody can tell, and the caller keeps the invoice for a
 * person.
 */
export async function scheduleRecordsInvoice(
  supabase: SupabaseClient,
  schedule: ClaimableSchedule,
  invoiceId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('recurring_invoice_schedules')
    .select('id')
    .eq('id', schedule.id)
    .eq('company_id', schedule.company_id)
    .eq('last_invoice_id', invoiceId)
  return !error && Array.isArray(data) && data.length > 0
}
