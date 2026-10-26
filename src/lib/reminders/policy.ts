import type { InvoiceDeliveryProviderStatus } from '@/types'
import type { DeliveryEvidence } from '@/lib/collections/eligibility'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'

/**
 * Whether one invoice gets a reminder today, and at which level (accounted#104).
 * Pure: the facts come in, a decision comes out, nothing is read or sent.
 *
 * The old sender (removed 2026-10-12) took status sent/overdue as proof that
 * an invoice was unpaid, reminded imported history and could open with the
 * final notice. Here:
 *
 * - Owed is the printed amount less what the customer paid (the collections
 *   claim), from the due date in Europe/Stockholm, never from status alone.
 *   The bank check is not here: it reads the bank, so the sender runs it
 *   after this says remind (dispatch.ts), and before every send.
 * - Only an invoice dated on or after the day the company turned reminders
 *   on, that reached the customer from Accounted, joins the ladder by
 *   itself. Anything older or imported is reminded only when a person picks
 *   it, and once one of our reminders went out it follows the ladder.
 * - Level 1 first, one level per decision, and a level waits both for its
 *   day after the due date and for the gap the schedule gives it after the
 *   previous reminder, so a picked old invoice never gets level 2 the next
 *   morning.
 * - Anything a customer or a provider told us stops the ladder: an answer to
 *   a reminder, a bounce, a send whose outcome is unknown.
 */

export const REMINDER_LEVELS = [1, 2, 3] as const
export type ReminderLevel = (typeof REMINDER_LEVELS)[number]

/** Days after the due date for level 1, 2 and 3 (the company_settings defaults). */
export const DEFAULT_REMINDER_DAYS = [15, 30, 45] as const

export interface ReminderSchedule {
  /** Days after the due date for level 1, 2 and 3; strictly increasing, 1 to 365. */
  days: readonly [number, number, number]
}

/**
 * The company's schedule, or the defaults when the stored days are not a
 * strictly increasing 1 to 365 (the table refuses that too; rows written
 * before the constraint, or a partial read, fall back rather than misfire).
 */
export function reminderSchedule(settings: {
  reminder_days_level_1?: number | null
  reminder_days_level_2?: number | null
  reminder_days_level_3?: number | null
}): ReminderSchedule {
  const days = [settings.reminder_days_level_1, settings.reminder_days_level_2, settings.reminder_days_level_3]
  const valid =
    days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 365) &&
    (days[0] as number) < (days[1] as number) &&
    (days[1] as number) < (days[2] as number)
  return { days: valid ? (days as [number, number, number]) : [...DEFAULT_REMINDER_DAYS] }
}

/** One reminder already on record for the invoice (invoice_reminders). */
export interface ReminderHistoryEntry {
  level: ReminderLevel
  status: 'reserved' | 'sent' | 'failed'
  /** Day it was sent in Europe/Stockholm (YYYY-MM-DD), null unless sent. */
  sentOn: string | null
  providerStatus: InvoiceDeliveryProviderStatus | null
  responseType: 'marked_paid' | 'disputed' | null
  /** Written by the old sender (no mode): history, never a step of this ladder. */
  legacy: boolean
}

/** What the decision needs to know about the invoice and its customer. */
export interface ReminderInvoiceFacts {
  /** invoice for a customer invoice of our own; credit notes, quotes and the like are 'other'. */
  kind: 'invoice' | 'other'
  status: string
  /** YYYY-MM-DD */
  invoiceDate: string
  /** YYYY-MM-DD */
  dueDate: string
  /** What the customer still owes of the printed amount (collectionClaim().remaining). */
  remaining: number
  /** A credit note against it that is not cancelled. */
  credited: boolean
  delivery: DeliveryEvidence
  /** Came from another system (migration_source_records). */
  imported: boolean
  /** Bankgirot debits it (autogiro payer number on the invoice). */
  autogiro: boolean
  /** The customer's invoice email, or null when there is none to remind. */
  recipient: string | null
  /** customers.reminders_excluded: "Skicka aldrig påminnelser". */
  customerExcluded: boolean
  /** The collections provider pursues it, or the company is connected (reminder-guard.ts). */
  withCollections: boolean
}

export interface ReminderDecisionInput {
  /** Today in Europe/Stockholm (YYYY-MM-DD). */
  today: string
  schedule: ReminderSchedule
  /** company_settings.reminders_enabled_at (ISO timestamp), null while reminders are off. */
  enabledAt: string | null
  invoice: ReminderInvoiceFacts
  history: readonly ReminderHistoryEntry[]
  /** A person picked this invoice for a reminder now (the invoice page), not the daily run. */
  picked?: boolean
}

/** Why an invoice gets no reminder today. Each is a sentence in the batch view (reminders.skip_*). */
export const REMINDER_SKIP_REASONS = [
  'not_invoice',
  'credited',
  'not_sent',
  'paid',
  'not_overdue',
  'collections',
  'customer_excluded',
  'autogiro',
  'no_email',
  'response',
  'in_flight',
  'send_failed',
  'undelivered',
  'earlier_reminders',
  'imported',
  'not_delivered',
  'before_enabled',
  'not_due',
  'complete',
] as const
export type ReminderSkipReason = (typeof REMINDER_SKIP_REASONS)[number]

export type ReminderDecision =
  | { kind: 'remind'; level: ReminderLevel }
  /** `nextOn` (YYYY-MM-DD) for not_due: the day the next level falls due. */
  | { kind: 'skip'; reason: ReminderSkipReason; nextOn?: string }

/** The statuses of an issued invoice that may still be owed (the collections rule). */
const OWED_STATUSES = new Set(['sent', 'overdue', 'partially_paid'])

/** Provider outcomes that mean the reminder did not reach the customer. */
const UNDELIVERED = new Set<InvoiceDeliveryProviderStatus>(['bounced', 'complained', 'failed', 'suppressed'])

function skip(reason: ReminderSkipReason, nextOn?: string): ReminderDecision {
  return nextOn ? { kind: 'skip', reason, nextOn } : { kind: 'skip', reason }
}

export function decideReminder(input: ReminderDecisionInput): ReminderDecision {
  const { invoice, history, today, schedule } = input

  // Owed, issued and overdue.
  if (invoice.kind !== 'invoice') return skip('not_invoice')
  if (invoice.credited) return skip('credited')
  if (!OWED_STATUSES.has(invoice.status)) return skip(invoice.status === 'paid' ? 'paid' : 'not_sent')
  if (invoice.remaining <= 0) return skip('paid')
  if (today <= invoice.dueDate) return skip('not_overdue')

  // Someone else reminds, or nobody may.
  if (invoice.withCollections) return skip('collections')
  if (invoice.customerExcluded) return skip('customer_excluded')
  if (invoice.autogiro) return skip('autogiro')
  if (!invoice.recipient) return skip('no_email')

  // What the customer and the provider told us.
  if (history.some((h) => h.responseType !== null)) return skip('response')
  if (history.some((h) => h.status === 'reserved')) return skip('in_flight')
  if (history.some((h) => h.status === 'failed')) return skip('send_failed')
  if (history.some((h) => h.providerStatus !== null && UNDELIVERED.has(h.providerStatus))) return skip('undelivered')

  const sent = history.filter((h) => h.status === 'sent')
  // The old sender's reminders hold the levels they used (one row per
  // invoice and level): a person decides what such an invoice gets next.
  if (sent.some((h) => h.legacy)) return skip('earlier_reminders')

  // Joining the ladder: by itself only when dated after the company turned
  // reminders on and delivered from Accounted; otherwise a person picks it.
  const inLadder = sent.length > 0
  if (!inLadder && !input.picked) {
    if (invoice.imported || invoice.delivery === 'no_history') return skip('imported')
    if (invoice.delivery === 'not_delivered') return skip('not_delivered')
    const enabledOn = input.enabledAt ? todayIsoStockholm(new Date(input.enabledAt)) : null
    if (!enabledOn || invoice.invoiceDate < enabledOn) return skip('before_enabled')
  }

  const highest = sent.reduce((max, h) => Math.max(max, h.level), 0)
  if (highest >= REMINDER_LEVELS.length) return skip('complete')
  const next = (highest + 1) as ReminderLevel

  // A picked invoice gets level 1 now; every later level waits as usual.
  if (input.picked && next === 1) return { kind: 'remind', level: 1 }

  let nextOn = addDaysIso(invoice.dueDate, schedule.days[next - 1])
  const lastSentOn = sent.map((h) => h.sentOn).filter((d): d is string => d !== null).sort().at(-1)
  if (next > 1 && lastSentOn) {
    const afterGap = addDaysIso(lastSentOn, schedule.days[next - 1] - schedule.days[next - 2])
    if (afterGap > nextOn) nextOn = afterGap
  }
  if (today < nextOn) return skip('not_due', nextOn)
  return { kind: 'remind', level: next }
}
