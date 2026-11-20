import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { REMINDERS_SENDING_ENABLED, remindersActiveFor } from '@/lib/invoices/reminders-enabled'
import { loadReminderContext } from './facts'
import { decideReminder, reminderSchedule, type ReminderDecisionInput } from './policy'

/**
 * Whether the daily ladder reminds one invoice by itself, for the invoice
 * page's Påminnelser card: the schedule ("efter 15, 30 och 45 dagar") is
 * promised only where it holds, never on an invoice dated before reminders
 * were turned on, an imported or registered one, or one the policy stops
 * for any other reason.
 *
 * Asked of the policy itself (decideReminder), not of a copy of its rules:
 * the invoice is decided as the daily run would decide it on the day its
 * first reminder falls due, or today when that day has passed. A reminder
 * then, or a later level that waits for its day, means the ladder follows
 * it; any skip means it does not.
 */
export function ladderFollows(input: Omit<ReminderDecisionInput, 'picked'>): boolean {
  const firstDue = addDaysIso(input.invoice.dueDate, input.schedule.days[0])
  const decision = decideReminder({ ...input, today: input.today > firstDue ? input.today : firstDue })
  return decision.kind === 'remind' || decision.reason === 'not_due'
}

export interface InvoiceReminderLadder {
  /** The company's reminders are on (and the product switch is). */
  on: boolean
  /** The ladder reminds this invoice by itself. */
  follows: boolean
  /** Days after the due date for level 1, 2 and 3. */
  days: readonly [number, number, number]
}

/** The invoice's place on the ladder, from the same facts the send reads (facts.ts). */
export async function loadInvoiceReminderLadder(
  db: SupabaseClient,
  companyId: string,
  invoiceId: string,
  options: { now: Date; sendingEnabled?: boolean },
): Promise<InvoiceReminderLadder> {
  const ctx = await loadReminderContext(db, companyId, invoiceId)
  const schedule = reminderSchedule(ctx.company)
  const on = remindersActiveFor(ctx.company.send_invoice_reminders, options.sendingEnabled ?? REMINDERS_SENDING_ENABLED)
  const follows =
    on &&
    !ctx.companyInactive &&
    ladderFollows({
      today: todayIsoStockholm(options.now),
      schedule,
      enabledAt: ctx.company.reminders_enabled_at ?? null,
      invoice: ctx.facts,
      history: ctx.history,
    })
  return { on, follows, days: schedule.days }
}
