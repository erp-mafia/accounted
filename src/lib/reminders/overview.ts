import type { SupabaseClient } from '@supabase/supabase-js'
import { mapWithConcurrency } from '@/lib/concurrency'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
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

export interface ReminderOverview {
  /** The product switch (REMINDERS_SENDING_ENABLED): without it nothing can be turned on. */
  available: boolean
  /** The company's reminders are on (and the product switch is). */
  enabled: boolean
  enabledAt: string | null
  schedule: ReminderSchedule
  /** A collections provider reminds this company's customers; our reminders stay off. */
  collectionsConnected: boolean
  /** Issued invoices still owed past their due date. */
  overdueCount: number
  /** Overdue invoices issued and delivered from Accounted before reminders were on: remindable once, now. */
  pickable: PickableInvoice[]
  /** More overdue invoices than PICKABLE_SCAN_LIMIT were there to look at. */
  pickableTruncated: boolean
  /** Automatic sending (phase 4): on, and whether it may be offered. */
  automatic: AutomaticReminderState
}

export async function loadReminderOverview(
  db: SupabaseClient,
  companyId: string,
  options: { now: Date; sendingEnabled?: boolean },
): Promise<ReminderOverview> {
  const sendingEnabled = options.sendingEnabled ?? REMINDERS_SENDING_ENABLED
  const today = todayIsoStockholm(options.now)

  const [settings, connections, overdue, automatic] = await Promise.all([
    db
      .from('company_settings')
      .select('send_invoice_reminders, reminders_enabled_at, reminder_days_level_1, reminder_days_level_2, reminder_days_level_3')
      .eq('company_id', companyId)
      .maybeSingle(),
    // The provider reminds a connected company's customers (reminder-guard.ts).
    db.from('collection_connections').select('id').eq('company_id', companyId).eq('state', 'active').limit(1),
    db
      .from('invoices')
      .select('id', { count: 'exact' })
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .gt('remaining_amount', 0)
      .lt('due_date', today)
      .order('due_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKABLE_SCAN_LIMIT),
    loadAutomaticReminderState(db, companyId),
  ])
  if (settings.error) throw new Error(`company_settings lookup failed: ${settings.error.message}`)
  if (overdue.error) throw new Error(`overdue invoices lookup failed: ${overdue.error.message}`)
  // Fail closed: if we cannot tell, nothing is offered.
  if (connections.error) throw new Error(`collection_connections lookup failed: ${connections.error.message}`)
  const row = (settings.data ?? {}) as {
    send_invoice_reminders?: boolean | null
    reminders_enabled_at?: string | null
    reminder_days_level_1?: number | null
    reminder_days_level_2?: number | null
    reminder_days_level_3?: number | null
  }
  const collectionsConnected = (connections.data ?? []).length > 0
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
  if (!sendingEnabled || collectionsConnected) return { ...base, pickable: [], pickableTruncated: false }

  const decided = await mapWithConcurrency(overdueRows, SCAN_CONCURRENCY, async ({ id }) => {
    const ctx = await loadReminderContext(db, companyId, id)
    if (ctx.companyInactive || !ctx.facts.recipient) return null
    // Decided as the ladder would, as if reminders started today: what it
    // leaves out only for being older than the turn-on is what a person may pick.
    const decision = decideReminder({
      today,
      schedule: base.schedule,
      enabledAt: options.now.toISOString(),
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

  return {
    ...base,
    pickable: decided.filter((p): p is PickableInvoice => p !== null).sort((a, b) => b.overdue_days - a.overdue_days),
    pickableTruncated: overdueCount > overdueRows.length,
  }
}
