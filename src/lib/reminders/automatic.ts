import type { SupabaseClient } from '@supabase/supabase-js'
import { REMINDER_BATCH_ITEM_KIND, REMINDER_BATCH_TYPE } from './batch'

/**
 * Automatic reminders (accounted#104, phase 4). By default every day's
 * reminders wait in Att göra for a person. Once a company's last
 * CLEAN_BATCHES_FOR_AUTOMATIC batches were approved without changes (nothing
 * taken out, nothing rejected), it is offered to let the batch send itself:
 * then the reminders whose bank check passed go out by themselves, and
 * anything uncertain (a bank not synced in 24 hours, or none connected)
 * still waits for a person. Turned off in the same places, and whenever
 * reminders are turned off (migration 20261027120300).
 */

/** Approved batches in a row, without changes, before automatic sending is offered (decided 2026-10-26). */
export const CLEAN_BATCHES_FOR_AUTOMATIC = 3

export interface AutomaticReminderState {
  /** Automatic sending is on. */
  on: boolean
  since: string | null
  /** The last CLEAN_BATCHES_FOR_AUTOMATIC batches were approved without changes. */
  eligible: boolean
  /** Clean batches in a row, newest first, up to CLEAN_BATCHES_FOR_AUTOMATIC. */
  cleanStreak: number
}

type Db = Pick<SupabaseClient, 'from'>

/** How many of the company's latest decided reminder batches in a row were approved without changes. */
export async function cleanBatchStreak(db: Db, companyId: string): Promise<number> {
  const { data: batches, error } = await db
    .from('pending_operations')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('operation_type', REMINDER_BATCH_TYPE)
    .in('status', ['committed', 'rejected'])
    .order('created_at', { ascending: false })
    .limit(CLEAN_BATCHES_FOR_AUTOMATIC)
  if (error) throw new Error(`reminder batch lookup failed: ${error.message}`)
  const recent = (batches ?? []) as Array<{ id: string; status: string }>
  const committed: string[] = []
  for (const batch of recent) {
    if (batch.status !== 'committed') break
    committed.push(batch.id)
  }
  if (committed.length === 0) return 0

  const { data: removals, error: removalsError } = await db
    .from('collection_batch_removals')
    .select('pending_operation_id')
    .eq('company_id', companyId)
    .eq('kind', REMINDER_BATCH_ITEM_KIND)
    .in('pending_operation_id', committed)
  if (removalsError) throw new Error(`collection_batch_removals lookup failed: ${removalsError.message}`)
  const changed = new Set(((removals ?? []) as Array<{ pending_operation_id: string }>).map((r) => r.pending_operation_id))
  const firstChanged = committed.findIndex((id) => changed.has(id))
  return firstChanged === -1 ? committed.length : firstChanged
}

export async function loadAutomaticReminderState(db: Db, companyId: string): Promise<AutomaticReminderState> {
  const [{ data: settings, error }, streak] = await Promise.all([
    db.from('company_settings').select('reminders_automatic_at').eq('company_id', companyId).maybeSingle(),
    cleanBatchStreak(db, companyId),
  ])
  if (error) throw new Error(`company_settings lookup failed: ${error.message}`)
  const since = (settings as { reminders_automatic_at?: string | null } | null)?.reminders_automatic_at ?? null
  return { on: since !== null, since, eligible: streak >= CLEAN_BATCHES_FOR_AUTOMATIC, cleanStreak: streak }
}

export type SetAutomaticOutcome = { ok: true; state: AutomaticReminderState } | { ok: false; code: 'REMINDERS_OFF' | 'REMINDERS_AUTOMATIC_NOT_YET' }

/**
 * Turn automatic sending on or off for a company. On needs reminders on and
 * the clean batches; off always works. Writes with the service role (the
 * column is Accounted's to set, migration 20261027120300); the caller has
 * checked that the person is an owner or administrator.
 */
export async function setAutomaticReminders(
  serviceDb: SupabaseClient,
  input: { companyId: string; enabled: boolean; userId: string; now: Date },
): Promise<SetAutomaticOutcome> {
  if (input.enabled) {
    const { data, error } = await serviceDb.from('company_settings').select('send_invoice_reminders').eq('company_id', input.companyId).maybeSingle()
    if (error) throw new Error(`company_settings lookup failed: ${error.message}`)
    if ((data as { send_invoice_reminders?: boolean | null } | null)?.send_invoice_reminders !== true) return { ok: false, code: 'REMINDERS_OFF' }
    if ((await cleanBatchStreak(serviceDb, input.companyId)) < CLEAN_BATCHES_FOR_AUTOMATIC) return { ok: false, code: 'REMINDERS_AUTOMATIC_NOT_YET' }
  }
  const { error: updateError } = input.enabled
    ? await serviceDb
        .from('company_settings')
        .update({ reminders_automatic_at: input.now.toISOString(), reminders_automatic_by: input.userId })
        .eq('company_id', input.companyId)
    : await serviceDb
        .from('company_settings')
        .update({ reminders_automatic_at: null, reminders_automatic_by: null })
        .eq('company_id', input.companyId)
  if (updateError) throw new Error(`automatic reminders not saved: ${updateError.message}`)
  return { ok: true, state: await loadAutomaticReminderState(serviceDb, input.companyId) }
}
