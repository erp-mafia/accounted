import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso, daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { resolveInvoiceReplyTo } from '@/lib/invoices/email-recipients'
import { loadReminderContext } from './facts'
import { decideReminder, reminderSchedule, type ReminderLevel } from './policy'
import { FINAL_REMINDER_PAY_WITHIN_DAYS, renderReminderEmail } from './templates'

/**
 * The reminder mail as the customer would get it, for a person to read
 * before turning reminders on or sending one: rendered from the invoice's
 * own facts with the same template the send uses. Without an invoice it
 * shows the company's most recent overdue invoice, else its most recent
 * issued one. The answer link points at an example token (it opens nothing).
 */

export interface ReminderPreview {
  invoiceId: string
  invoiceNumber: string | null
  /** The level shown: the one asked for, else the one a pick would send now. */
  level: ReminderLevel
  subject: string
  html: string
  /** Recipients of the real send. */
  to: string | null
}

export class NoInvoiceToPreviewError extends Error {
  constructor() {
    super('No invoice to preview a reminder with')
    this.name = 'NoInvoiceToPreviewError'
  }
}

async function sampleInvoiceId(db: SupabaseClient, companyId: string, today: string): Promise<string | null> {
  const issued = ['sent', 'overdue', 'partially_paid']
  const overdue = await db
    .from('invoices')
    .select('id')
    .eq('company_id', companyId)
    .in('status', issued)
    .lt('due_date', today)
    .order('due_date', { ascending: false })
    .limit(1)
  if (overdue.error) throw new Error(`invoice lookup failed: ${overdue.error.message}`)
  const first = (overdue.data ?? [])[0] as { id: string } | undefined
  if (first) return first.id
  const latest = await db
    .from('invoices')
    .select('id')
    .eq('company_id', companyId)
    .in('status', [...issued, 'paid'])
    .order('invoice_date', { ascending: false })
    .limit(1)
  if (latest.error) throw new Error(`invoice lookup failed: ${latest.error.message}`)
  return ((latest.data ?? [])[0] as { id: string } | undefined)?.id ?? null
}

export async function renderReminderPreview(
  db: SupabaseClient,
  companyId: string,
  input: { invoiceId?: string; level?: ReminderLevel; now: Date },
): Promise<ReminderPreview> {
  const today = todayIsoStockholm(input.now)
  const invoiceId = input.invoiceId ?? (await sampleInvoiceId(db, companyId, today))
  if (!invoiceId) throw new NoInvoiceToPreviewError()

  const ctx = await loadReminderContext(db, companyId, invoiceId)
  // An invoice without a customer has nobody to remind.
  if (!ctx.customer) throw new NoInvoiceToPreviewError()
  const decision = decideReminder({
    today,
    schedule: reminderSchedule(ctx.company),
    enabledAt: ctx.company.reminders_enabled_at ?? null,
    invoice: ctx.facts,
    history: ctx.history,
    picked: true,
  })
  const level = input.level ?? (decision.kind === 'remind' ? decision.level : 1)
  // A paid sample still shows a reminder with something to pay.
  const remaining = ctx.facts.remaining > 0 ? ctx.facts.remaining : ctx.amount
  const mail = renderReminderEmail({
    level,
    invoice: ctx.invoice,
    customer: ctx.customer,
    company: ctx.company,
    amount: ctx.amount,
    remaining,
    payBy: addDaysIso(today, FINAL_REMINDER_PAY_WITHIN_DAYS),
    overdueDays: Math.max(0, daysBetweenIso(ctx.invoice.due_date, today)),
    actionUrl: `${await getBaseUrlForCompany(companyId)}/invoice-action/exempel`,
    replyTo: resolveInvoiceReplyTo(ctx.company),
  })
  return { invoiceId, invoiceNumber: ctx.invoice.invoice_number ?? null, level, subject: mail.subject, html: mail.html, to: ctx.facts.recipient }
}
