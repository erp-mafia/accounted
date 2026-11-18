/**
 * A recurring schedule moves its period_start one interval on when it spawns
 * a draft (cron and "Skapa faktura nu"). A draft removed before it was issued
 * (hard-deleted unnumbered, or makulerad numbered) billed nothing, so the
 * schedule's period goes back to the one that draft covered (crm#1285).
 * Without this the next run bills the period after it, and the removed
 * draft's period is skipped for good.
 *
 * Only the schedule's LATEST spawn moves the period back: the schedule is
 * found through last_invoice_id, which every run overwrites. An older draft's
 * period is followed by periods later runs already billed, so stepping back
 * would bill one of those twice. The caller reads the schedule together with
 * the invoice, before the removal, because deleting the invoice nulls
 * last_invoice_id (ON DELETE SET NULL).
 *
 * next_run_date is left alone. It is the cadence, not what is billed: the
 * next scheduled run, or "Skapa faktura nu", bills the restored period.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { previousPeriodStart } from '@/lib/invoices/recurring-placeholders'

/**
 * The schedule an invoice was spawned from, as embedded on the invoice row
 * (`spawned_by:recurring_invoice_schedules!last_invoice_id(...)`).
 */
export interface SpawningSchedule {
  id: string
  period_start: string | null
  interval_months: number | null
}

/** The single spawning schedule from the embed (an array, or absent). */
export function spawningScheduleOf(embed: unknown): SpawningSchedule | null {
  const rows = Array.isArray(embed) ? embed : embed ? [embed] : []
  const row = rows[0] as SpawningSchedule | undefined
  return row?.id ? row : null
}

/**
 * Step the schedule's period back after its latest draft was removed unsent.
 * Compare-and-set on the period_start read with the invoice, so a run that
 * spawned again in between (and moved the period on) is left as it is.
 * Best-effort: the removal already happened, so a failure is logged and
 * reported as false, never thrown.
 */
export async function restoreSchedulePeriodForRemovedDraft(params: {
  supabase: SupabaseClient
  companyId: string
  invoiceId: string
  schedule: SpawningSchedule
  /** 'deleted' nulled last_invoice_id through the FK; 'cancelled' kept it. */
  outcome: 'deleted' | 'cancelled'
  log?: Logger
}): Promise<boolean> {
  const { supabase, companyId, invoiceId, schedule, outcome, log } = params
  if (!schedule.period_start) return false

  const restored = previousPeriodStart(schedule.period_start, schedule.interval_months ?? 1)
  const base = supabase
    .from('recurring_invoice_schedules')
    .update({ period_start: restored })
    .eq('id', schedule.id)
    .eq('company_id', companyId)
    .eq('period_start', schedule.period_start)
  const gated = outcome === 'deleted'
    ? base.is('last_invoice_id', null)
    : base.eq('last_invoice_id', invoiceId)
  const { data, error } = await gated.select('id')

  if (error) {
    log?.error('recurring schedule period not restored after its draft was removed', error, {
      scheduleId: schedule.id,
      invoiceId,
    })
    return false
  }
  return Array.isArray(data) && data.length > 0
}
