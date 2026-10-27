import type { SupabaseClient } from '@supabase/supabase-js'
import { collectionClaim } from '@/lib/collections/eligibility'
import { calculateReminderAmounts, REMINDER_FEE_CURRENCY } from '@/lib/email/reminder-templates'
import { roundOre } from '@/lib/money'
import type { ReminderResponseType } from '@/types'

/**
 * The customer's answer to a reminder: the public page behind the link in
 * every reminder mail (/invoice-action/[token]). The token is the only key,
 * so this reads with the service role and returns only what the page shows.
 *
 * The page shows what is left to pay today, not the printed total, in the
 * customer's language. "Jag har betalat" and "Något stämmer inte" both stop
 * further reminders of the invoice (policy.ts reads response_type), and the
 * customer may say why in a short note the company sees on the invoice.
 *
 * Reminders of the old sender (removed 2026-10-12) may carry a fee and
 * interest; they are shown as they were sent. New reminders carry neither.
 */

export { REMINDER_ANSWER_ACTIONS, REMINDER_ANSWER_NOTE_MAX } from './answer-limits'

export interface ReminderAnswerView {
  language: 'sv' | 'en'
  companyName: string
  customerName: string | null
  invoiceNumber: string | null
  invoiceDate: string
  dueDate: string
  currency: string
  /** What the invoice asked for, in `currency`. */
  amount: number
  /** What came in against it. */
  paid: number
  /** What is left to pay today, in `currency`, before the old sender's fee and interest. */
  remaining: number
  reminderLevel: number
  alreadyResponded: boolean
  previousResponse: ReminderResponseType | null
  /** The old sender's dröjsmålsränta, in `currency`; 0 on new reminders. */
  interestAmount: number
  interestRate: number
  interestDays: number | null
  /** The old sender's påminnelseavgift, always SEK; 0 on new reminders. */
  reminderFee: number
  reminderFeeCurrency: string
  /** remaining plus interest, plus the fee when the invoice is in SEK. */
  totalDue: number
  /** The fee in SEK when it cannot share the invoice's currency. */
  feeDueSeparately: number
}

type Db = Pick<SupabaseClient, 'from'>

interface ReminderRow {
  id: string
  company_id: string
  reminder_level: number
  response_type: ReminderResponseType | null
  action_token_used: boolean
  interest_amount: number | null
  interest_rate: number | null
  interest_days: number | null
  reminder_fee: number | null
  invoice: InvoiceRow | InvoiceRow[] | null
}

interface InvoiceRow {
  invoice_number: string | null
  invoice_date: string
  due_date: string
  total: number
  vat_amount: number
  currency: string
  paid_amount: number | null
  deduction_total: number | null
  remaining_amount: number | null
  credited_invoice_id: string | null
  ore_rounding: boolean | null
  customer: { name: string | null; language: string | null } | Array<{ name: string | null; language: string | null }> | null
}

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value)
}

/** A reminder that reached the customer, by its link token; null for any other token. */
async function findSentReminder(db: Db, token: string): Promise<ReminderRow | null> {
  const { data, error } = await db
    .from('invoice_reminders')
    .select(
      `id, company_id, reminder_level, response_type, action_token_used,
       interest_amount, interest_rate, interest_days, reminder_fee,
       invoice:invoices(
         invoice_number, invoice_date, due_date, total, vat_amount, currency,
         paid_amount, deduction_total, remaining_amount, credited_invoice_id, ore_rounding,
         customer:customers(name, language)
       )`,
    )
    .eq('action_token', token)
    .eq('status', 'sent')
    .maybeSingle()
  if (error) throw new Error(`reminder lookup failed: ${error.message}`)
  return (data as ReminderRow | null) ?? null
}

/** The page's view of a sent reminder, and its company for the brand; null for any other token. */
export async function loadReminderAnswer(db: Db, token: string): Promise<{ companyId: string; view: ReminderAnswerView } | null> {
  const reminder = await findSentReminder(db, token)
  const invoice = reminder ? one(reminder.invoice) : null
  if (!reminder || !invoice) return null

  const { data: settings, error } = await db
    .from('company_settings')
    .select('company_name, ore_rounding')
    .eq('company_id', reminder.company_id)
    .maybeSingle()
  if (error) throw new Error(`company lookup failed: ${error.message}`)
  const company = (settings ?? {}) as { company_name?: string | null; ore_rounding?: boolean | null }

  const claim = collectionClaim(
    {
      total: num(invoice.total),
      vat_amount: num(invoice.vat_amount),
      currency: invoice.currency,
      paid_amount: invoice.paid_amount === null ? null : num(invoice.paid_amount),
      deduction_total: invoice.deduction_total === null ? null : num(invoice.deduction_total),
      credited_invoice_id: invoice.credited_invoice_id,
      ore_rounding: invoice.ore_rounding,
    },
    company.ore_rounding ?? null,
  )
  const remaining = num(invoice.remaining_amount) <= 0 ? 0 : claim.remaining
  const interestAmount = num(reminder.interest_amount)
  const reminderFee = num(reminder.reminder_fee)
  const amounts = calculateReminderAmounts({ invoiceTotal: remaining, interestAmount, reminderFee, currency: invoice.currency })
  const customer = one(invoice.customer)

  const view: ReminderAnswerView = {
    language: customer?.language === 'en' ? 'en' : 'sv',
    companyName: company.company_name?.trim() || '',
    customerName: customer?.name ?? null,
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    dueDate: invoice.due_date,
    currency: invoice.currency,
    amount: claim.amount,
    paid: Math.max(0, roundOre(claim.amount - remaining)),
    remaining,
    reminderLevel: reminder.reminder_level,
    alreadyResponded: reminder.action_token_used,
    previousResponse: reminder.response_type,
    interestAmount,
    interestRate: num(reminder.interest_rate),
    interestDays: reminder.interest_days,
    reminderFee,
    reminderFeeCurrency: REMINDER_FEE_CURRENCY,
    totalDue: amounts.totalDue,
    feeDueSeparately: amounts.feeDueSeparately,
  }
  return { companyId: reminder.company_id, view }
}

export type RecordAnswerResult = 'recorded' | 'not_found' | 'already_answered'

/** Records the customer's answer once; a used link answers already_answered. */
export async function recordReminderAnswer(
  db: Db,
  input: { token: string; action: ReminderResponseType; note: string | null; now: Date },
): Promise<RecordAnswerResult> {
  const reminder = await findSentReminder(db, input.token)
  if (!reminder) return 'not_found'
  if (reminder.action_token_used) return 'already_answered'

  const at = input.now.toISOString()
  // Only an unused link is written: two answers racing, the second finds it used.
  const write = (note: string | null) =>
    note
      ? db
          .from('invoice_reminders')
          .update({ response_type: input.action, response_at: at, action_token_used: true, response_note: note })
          .eq('id', reminder.id)
          .eq('action_token_used', false)
          .select('id')
      : db
          .from('invoice_reminders')
          .update({ response_type: input.action, response_at: at, action_token_used: true })
          .eq('id', reminder.id)
          .eq('action_token_used', false)
          .select('id')
  let { data, error } = await write(input.note)
  // Deployed before migration 20261027120000 adds response_note: keep the
  // answer, which is what stops the reminders, and let the note go.
  if (error && input.note && (error.code === 'PGRST204' || error.code === '42703')) {
    ;({ data, error } = await write(null))
  }
  if (error) throw new Error(`reminder answer not saved: ${error.message}`)
  return (data ?? []).length > 0 ? 'recorded' : 'already_answered'
}
