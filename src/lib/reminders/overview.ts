import type { SupabaseClient } from '@supabase/supabase-js'
import { mapWithConcurrency } from '@/lib/concurrency'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { filterOverdueInvoices } from '@/lib/invoices/overdue'
import { REMINDERS_SENDING_ENABLED, remindersActiveFor } from '@/lib/invoices/reminders-enabled'
import { roundOre } from '@/lib/money'
import { loadAutomaticReminderState, type AutomaticReminderState } from './automatic'
import { loadReminderContext } from './facts'
import { decideReminder, reminderSchedule, type ReminderSchedule } from './policy'

/**
 * What the turn-on sheet shows (accounted#104, phase 3): whether reminders
 * can be turned on here, whether they are, the days of the ladder, and the
 * overdue invoices a person may remind once, now.
 *
 * Turning reminders on only enrols invoices issued from then on (policy.ts),
 * so the overdue invoices of today get nothing by themselves. The sheet
 * offers the ones issued and delivered from Accounted, each left unticked:
 * the person picks. Imported invoices are never offered in bulk (the old
 * sender reminded imported history that was long paid); they are reminded
 * one by one from the invoice.
 */

/** Overdue invoices read for the pick list, newest due date first. */
export const PICKABLE_SCAN_LIMIT = 100

/** Invoices decided at once while building the pick list. */
const SCAN_CONCURRENCY = 6

export interface PickableInvoice {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  recipient: string
  due_date: string
  overdue_days: number
  remaining_amount: number
  currency: string
}

/**
 * What the invoice list needs to choose between the offer, the status
 * control and nothing: flags and one count, a handful of queries, never the
 * pick list (loadReminderSummary).
 */
export interface ReminderSummary {
  /** The product switch (REMINDERS_SENDING_ENABLED): without it nothing can be turned on. */
  available: boolean
  /** The company's reminders are on (and the product switch is). */
  enabled: boolean
  enabledAt: string | null
  /** A collections provider reminds this company's customers; our reminders stay off. */
  collectionsConnected: boolean
  /**
   * Overdue invoices the sheet could offer to pick: in the summary one count
   * (countOfferableInvoices), in the full overview the pick list's length.
   */
  offerableCount: number
}

export interface ReminderOverview extends ReminderSummary {
  schedule: ReminderSchedule
  /** Issued invoices still owed past their due date. */
  overdueCount: number
  /** Overdue invoices issued and delivered from Accounted before reminders were on: remindable once, now. */
  pickable: PickableInvoice[]
  /** More overdue invoices than PICKABLE_SCAN_LIMIT were there to look at. */
  pickableTruncated: boolean
  /** Automatic sending (phase 4): on, and whether it may be offered. */
  automatic: AutomaticReminderState
}

/**
 * The overdue invoices the sheet could offer, as far as one count can tell
 * them apart: an owed customer invoice of our own (not a credit note, not
 * self-billed, not on autogiro) past its due date, whose customer has an
 * email address and is not marked "Skicka aldrig påminnelser", with an email
 * send from Accounted on record (sent or marked sent). What only the full
 * decision sees stays out of it: a bounced send, a delivery by Peppol alone,
 * a credit note against the invoice, an address the send would refuse,
 * history from another system. So a migrated company, whose invoices have no
 * send of ours, is not offered its imported backlog.
 */
async function countOfferableInvoices(db: SupabaseClient, companyId: string, today: string): Promise<number> {
  const { count, error } = await filterOverdueInvoices(
    db
      .from('invoices')
      .select('id, customer:customers!inner(email, reminders_excluded), invoice_deliveries!inner(status)', { count: 'exact', head: true })
      .eq('company_id', companyId),
    today,
  )
    .eq('is_self_billed', false)
    .is('autogiro_payer_number', null)
    .not('customer.email', 'is', null)
    .neq('customer.email', '')
    .eq('customer.reminders_excluded', false)
    .in('invoice_deliveries.status', ['sent', 'marked_sent'])
  if (error) throw new Error(`offerable invoices count failed: ${error.message}`)
  return count ?? 0
}

async function loadSwitches(db: SupabaseClient, companyId: string) {
  const [settings, connections] = await Promise.all([
    db
      .from('company_settings')
      .select('send_invoice_reminders, reminders_enabled_at, reminder_days_level_1, reminder_days_level_2, reminder_days_level_3')
      .eq('company_id', companyId)
      .maybeSingle(),
    // The provider reminds a connected company's customers (reminder-guard.ts).
    db.from('collection_connections').select('id').eq('company_id', companyId).eq('state', 'active').limit(1),
  ])
  if (settings.error) throw new Error(`company_settings lookup failed: ${settings.error.message}`)
  // Fail closed: if we cannot tell, nothing is offered.
  if (connections.error) throw new Error(`collection_connections lookup failed: ${connections.error.message}`)
  const row = (settings.data ?? {}) as {
    send_invoice_reminders?: boolean | null
    reminders_enabled_at?: string | null
    reminder_days_level_1?: number | null
    reminder_days_level_2?: number | null
    reminder_days_level_3?: number | null
  }
  return { row, collectionsConnected: (connections.data ?? []).length > 0 }
}

/**
 * The invoice list's read: the switches and the offer's count, without the
 * pick list (each of its invoices reads a dozen tables). The count is asked
 * only where the offer can show: reminders off, no collections provider.
 */
export async function loadReminderSummary(
  db: SupabaseClient,
  companyId: string,
  options: { now: Date; sendingEnabled?: boolean },
): Promise<ReminderSummary> {
  const sendingEnabled = options.sendingEnabled ?? REMINDERS_SENDING_ENABLED
  const { row, collectionsConnected } = await loadSwitches(db, companyId)
  const enabled = remindersActiveFor(row.send_invoice_reminders, sendingEnabled)
  const offerable = sendingEnabled && !enabled && !collectionsConnected
  return {
    available: sendingEnabled,
    enabled,
    enabledAt: row.reminders_enabled_at ?? null,
    collectionsConnected,
    offerableCount: offerable ? await countOfferableInvoices(db, companyId, todayIsoStockholm(options.now)) : 0,
  }
}

export async function loadReminderOverview(
  db: SupabaseClient,
  companyId: string,
  options: { now: Date; sendingEnabled?: boolean },
): Promise<ReminderOverview> {
  const sendingEnabled = options.sendingEnabled ?? REMINDERS_SENDING_ENABLED
  const today = todayIsoStockholm(options.now)

  const [{ row, collectionsConnected }, overdue, automatic] = await Promise.all([
    loadSwitches(db, companyId),
    // The one overdue rule (lib/invoices/overdue.ts), so a sent credit note
    // or a proforma is never counted or offered here (crm#1435).
    filterOverdueInvoices(db.from('invoices').select('id', { count: 'exact' }).eq('company_id', companyId), today)
      .order('due_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKABLE_SCAN_LIMIT),
    loadAutomaticReminderState(db, companyId),
  ])
  if (overdue.error) throw new Error(`overdue invoices lookup failed: ${overdue.error.message}`)
  const overdueRows = (overdue.data ?? []) as Array<{ id: string }>
  const overdueCount = overdue.count ?? overdueRows.length

  const base = {
    available: sendingEnabled,
    enabled: remindersActiveFor(row.send_invoice_reminders, sendingEnabled),
    enabledAt: row.reminders_enabled_at ?? null,
    schedule: reminderSchedule(row),
    collectionsConnected,
    overdueCount,
    automatic,
  }
  if (!sendingEnabled || collectionsConnected) return { ...base, pickable: [], pickableTruncated: false, offerableCount: 0 }
  // The ladder's own start while reminders are on, so what it already
  // follows is never offered (a pick would send its level 1 early); while
  // off, as if reminders started now.
  const enabledAt = base.enabled ? (row.reminders_enabled_at ?? null) : options.now.toISOString()

  const decided = await mapWithConcurrency(overdueRows, SCAN_CONCURRENCY, async ({ id }) => {
    const ctx = await loadReminderContext(db, companyId, id)
    if (ctx.companyInactive || !ctx.facts.recipient) return null
    // Decided as the ladder would: what it leaves out only for being older
    // than the turn-on is what a person may pick.
    const decision = decideReminder({
      today,
      schedule: base.schedule,
      enabledAt,
      invoice: ctx.facts,
      history: ctx.history,
    })
    const olderThanTurnOn = decision.kind === 'skip' && decision.reason === 'before_enabled'
    if (!olderThanTurnOn) return null
    const pick: PickableInvoice = {
      invoice_id: ctx.invoice.id,
      invoice_number: ctx.invoice.invoice_number ?? null,
      customer_name: ctx.customer?.name ?? null,
      recipient: ctx.facts.recipient,
      due_date: ctx.invoice.due_date,
      overdue_days: daysBetweenIso(ctx.invoice.due_date, today),
      remaining_amount: roundOre(ctx.facts.remaining),
      currency: ctx.invoice.currency,
    }
    return pick
  })

  const pickable = decided.filter((p): p is PickableInvoice => p !== null).sort((a, b) => b.overdue_days - a.overdue_days)
  return {
    ...base,
    pickable,
    pickableTruncated: overdueCount > overdueRows.length,
    offerableCount: pickable.length,
  }
}
