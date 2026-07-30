import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { RecurringScheduleItemSchema } from '@/lib/api/schemas'
import { createLogger } from '@/lib/logger'

/**
 * Apply an edit to a recurring invoice schedule: the header fields first, then
 * a full replace of its items (delete everything, reinsert the new set with
 * `schedule_id` stamped on).
 *
 * Neither write is atomic over PostgREST, and a combined edit touches two
 * tables, so BOTH writes are compensated on failure:
 *   - the items are snapshotted before the delete and best-effort reinserted
 *     when the insert fails (without that, a rejected insert leaves the
 *     schedule with ZERO items and every cron run throws "schedule has no
 *     items", silently skipping billing dates), and
 *   - the header fields are snapshotted before the update and rolled back to
 *     their previous values, so an item failure cannot leave a half-applied
 *     edit (a new day_of_month kept while the line edit was undone).
 *
 * Same snapshot/restore idiom as replaceInvoiceItems in
 * lib/invoices/replace-invoice-items.ts. `itemsRestored` / `headerRestored` on
 * the failure shapes say whether the schedule is back in its prior state; when
 * either is false the caller must tell the user the schedule may be partially
 * saved instead of reporting a clean failure.
 *
 * Shared by the cookie PATCH route (app/api/invoices/recurring/[id]) and the
 * update_recurring_schedule commit executor so the two surfaces cannot drift.
 */

const moduleLog = createLogger('invoices/recurring-schedule-update')

export type RecurringScheduleItemInput = z.infer<typeof RecurringScheduleItemSchema>

/** Server-generated recurring_invoice_schedule_items columns, never re-inserted. */
const SERVER_GENERATED_ITEM_COLUMNS = ['id', 'created_at'] as const

/** Minimal logger surface, so callers can pass their own module logger. */
type Log = { error: (message: string, ...args: unknown[]) => void }

export type ApplyRecurringScheduleUpdateResult =
  | { ok: true }
  /** The header update itself failed: nothing else was written. */
  | { ok: false; stage: 'header'; error: PostgrestError }
  | {
      ok: false
      stage: 'items_delete' | 'items_insert'
      error: PostgrestError
      /** Whether the pre-delete item rows are back (or never went away). */
      itemsRestored: boolean
      /** Whether the header fields are back at their pre-edit values. */
      headerRestored: boolean
    }

export async function applyRecurringScheduleUpdate(
  supabase: SupabaseClient,
  opts: {
    scheduleId: string
    companyId: string
    /** Header columns to write. Empty object = no header write at all. */
    fields: Record<string, unknown>
    /** Provided = replace all items; omitted = keep the existing ones. */
    items?: RecurringScheduleItemInput[]
    log?: Log
  },
): Promise<ApplyRecurringScheduleUpdateResult> {
  const { scheduleId, companyId, fields, items, log = moduleLog } = opts
  const hasFields = Object.keys(fields).length > 0
  if (!hasFields && !items) return { ok: true }

  // Snapshot the header only for a combined edit: that is the only case with a
  // committed header write that a later item failure has to undo. A header-only
  // edit has nothing after it that can fail, and an item-only edit writes no
  // header at all, so skipping the read there keeps both paths at their current
  // number of round trips.
  let headerSnapshot: Record<string, unknown> | null = null
  if (hasFields && items) {
    // select('*') on purpose: the restore must be able to put back every
    // column named in `fields`, including ones added to the update schema after
    // this function was written, so an explicit list here would silently fail
    // to restore new fields.
    const { data } = await supabase
      .from('recurring_invoice_schedules')
      .select('*')
      .eq('id', scheduleId)
      .eq('company_id', companyId)
      .maybeSingle()
    headerSnapshot = (data as Record<string, unknown> | null) ?? null
  }

  let headerStamp: string | null = null
  if (hasFields) {
    const { data: updated, error: updateError } = await supabase
      .from('recurring_invoice_schedules')
      .update(fields)
      .eq('id', scheduleId)
      .eq('company_id', companyId)
      .select('updated_at')
      .maybeSingle()

    if (updateError) return { ok: false, stage: 'header', error: updateError }
    // Used to guard the rollback below. Null (no representation returned, or a
    // mock) deliberately falls back to an unguarded restore: putting the user's
    // own prior values back matters more than the race window.
    headerStamp = (updated as { updated_at?: string } | null)?.updated_at ?? null
  }

  if (!items) return { ok: true }

  // Snapshot the items before deleting them, keeping the error: a snapshot that
  // could not be read must not be reported as a successful restore.
  const { data: snapshotRows, error: snapshotError } = await supabase
    .from('recurring_invoice_schedule_items')
    .select('*')
    .eq('schedule_id', scheduleId)

  const { error: deleteError } = await supabase
    .from('recurring_invoice_schedule_items')
    .delete()
    .eq('schedule_id', scheduleId)

  if (deleteError) {
    // Nothing was removed, so the items are trivially intact; the header write
    // still has to be undone.
    const headerRestored = await restoreHeaderFields(supabase, {
      scheduleId,
      companyId,
      fields,
      snapshot: headerSnapshot,
      headerStamp,
      log,
    })
    return {
      ok: false,
      stage: 'items_delete',
      error: deleteError,
      itemsRestored: true,
      headerRestored,
    }
  }

  const itemRows = items.map((item, idx) => ({
    schedule_id: scheduleId,
    sort_order: idx,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    vat_rate: item.vat_rate ?? null,
    dimensions: item.dimensions ?? {},
  }))

  const { error: insertError } = await supabase
    .from('recurring_invoice_schedule_items')
    .insert(itemRows)

  if (insertError) {
    // Best-effort restore of the previous lines so the schedule stays valid for
    // the cron. A failed (or impossible) restore is reported, never swallowed.
    let itemsRestored = false
    if (snapshotError || snapshotRows == null) {
      itemsRestored = false
    } else if (snapshotRows.length === 0) {
      // Nothing existed before, so the prior (empty) state already holds.
      itemsRestored = true
    } else {
      const restoreRows = (snapshotRows as Record<string, unknown>[]).map((row) => {
        const copy: Record<string, unknown> = { ...row }
        for (const column of SERVER_GENERATED_ITEM_COLUMNS) delete copy[column]
        copy.schedule_id = scheduleId
        return copy
      })
      const { error: restoreError } = await supabase
        .from('recurring_invoice_schedule_items')
        .insert(restoreRows)
      itemsRestored = !restoreError
      if (restoreError) {
        log.error(
          'recurring schedule items restore failed: schedule may be left with no items',
          restoreError,
          { scheduleId, companyId, previousItems: restoreRows },
        )
      }
    }

    const headerRestored = await restoreHeaderFields(supabase, {
      scheduleId,
      companyId,
      fields,
      snapshot: headerSnapshot,
      headerStamp,
      log,
    })

    return {
      ok: false,
      stage: 'items_insert',
      error: insertError,
      itemsRestored,
      headerRestored,
    }
  }

  return { ok: true }
}

/**
 * Put the header columns named in `fields` back at their snapshot values.
 * Returns whether the schedule's header is known to be in its pre-edit state.
 */
async function restoreHeaderFields(
  supabase: SupabaseClient,
  opts: {
    scheduleId: string
    companyId: string
    fields: Record<string, unknown>
    snapshot: Record<string, unknown> | null
    headerStamp: string | null
    log: Log
  },
): Promise<boolean> {
  const { scheduleId, companyId, fields, snapshot, headerStamp, log } = opts
  const keys = Object.keys(fields)
  if (keys.length === 0) return true // No header write happened.

  if (!snapshot) {
    log.error(
      'recurring schedule header snapshot missing: the field update cannot be rolled back',
      undefined,
      { scheduleId, companyId, fields },
    )
    return false
  }

  const restoreRow: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in snapshot) restoreRow[key] = snapshot[key]
  }
  if (Object.keys(restoreRow).length !== keys.length) {
    // A partial restore could null out a column that was never read back, so
    // report the half-saved state instead of writing a guess.
    log.error(
      'recurring schedule header snapshot incomplete: fields may be left half-saved',
      undefined,
      { scheduleId, companyId, fields, snapshotKeys: Object.keys(snapshot) },
    )
    return false
  }

  // Guard the rollback on the stamp our own update produced. The table has an
  // updated_at trigger (migration 20260518150000,
  // recurring_invoice_schedules_updated_at), so a non-matching stamp means a
  // concurrent writer (the hourly cron, a second edit) landed in between; its
  // value must win rather than be clobbered from a stale snapshot. That is the
  // exact failure documented as audit finding C2 in
  // lib/invoices/voucher-matching.ts.
  let query = supabase
    .from('recurring_invoice_schedules')
    .update(restoreRow)
    .eq('id', scheduleId)
    .eq('company_id', companyId)
  if (headerStamp) query = query.eq('updated_at', headerStamp)
  const { data, error } = await query.select('id')

  if (error || !data || (data as unknown[]).length === 0) {
    log.error(
      'recurring schedule header rollback did not apply: fields may be left half-saved',
      error ?? undefined,
      { scheduleId, companyId, restoreRow, headerStamp },
    )
    return false
  }
  return true
}
