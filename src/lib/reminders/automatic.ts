import type { SupabaseClient } from '@supabase/supabase-js'
import { REMINDER_BATCH_ITEM_KIND, REMINDER_BATCH_TYPE } from './batch'

/**
 * Automatic reminders (accounted#104, phase 4). By default every day's
 * reminders wait in Att göra for a person. Once a company's last
 * CLEAN_BATCHES_FOR_AUTOMATIC batches since reminders went on were approved
 * without changes (cleanBatchStreak), it is offered to let the batch send itself:
 * then the reminders whose bank check passed, for invoices issued and
 * delivered from Accounted, go out by themselves, and anything else (a bank
 * not synced in 24 hours or none connected, an imported invoice) still
 * waits for a person. Turned off in the same places, and whenever
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

/**
 * Decided batches read when counting the streak. More than the streak: a
 * batch that only listed invoices (nothing staged to send) is passed over.
 */
const STREAK_LOOKBACK = CLEAN_BATCHES_FOR_AUTOMATIC * 5

interface DecidedBatch {
  id: string
  status: string
  /** preview_data.item_count: the reminders staged to send. */
  item_count: unknown
  /** result_data.sent_count and .skipped, written by the commit (batch-commit.ts). */
  sent_count: unknown
  skipped: unknown
}

/**
 * How many of the company's latest decided reminder batches in a row were
 * approved without changes, counting only batches staged since reminders
 * were last turned on (company_settings.reminders_enabled_at). Clean:
 * committed, at least one reminder sent, nothing taken out, and nothing
 * found changed at the send (batch_skip_changed). A rejected batch, or one
 * that sent nothing, ends the streak. A batch that only listed invoices
 * counts neither way.
 */
export async function cleanBatchStreak(db: Db, companyId: string): Promise<number> {
  const { data: settings, error: settingsError } = await db
    .from('company_settings')
    .select('reminders_enabled_at')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw new Error(`company_settings lookup failed: ${settingsError.message}`)
  const enabledAt = (settings as { reminders_enabled_at?: string | null } | null)?.reminders_enabled_at ?? null
  // Reminders off: no streak, and turning them on again starts a new one.
  if (!enabledAt) return 0

  const { data: batches, error } = await db
    .from('pending_operations')
    .select('id, status, item_count:preview_data->item_count, sent_count:result_data->sent_count, skipped:result_data->skipped')
    .eq('company_id', companyId)
    .eq('operation_type', REMINDER_BATCH_TYPE)
    .in('status', ['committed', 'rejected'])
    .gt('created_at', enabledAt)
    .order('created_at', { ascending: false })
    .limit(STREAK_LOOKBACK)
  if (error) throw new Error(`reminder batch lookup failed: ${error.message}`)
  const committed: string[] = []
  for (const batch of (batches ?? []) as DecidedBatch[]) {
    if (batch.item_count === 0) continue
    const sent = typeof batch.sent_count === 'number' ? batch.sent_count : 0
    const changed = Array.isArray(batch.skipped) && batch.skipped.some((s) => (s as { reason?: unknown } | null)?.reason === 'changed')
    if (batch.status !== 'committed' || sent < 1 || changed) break
    committed.push(batch.id)
    if (committed.length === CLEAN_BATCHES_FOR_AUTOMATIC) break
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
