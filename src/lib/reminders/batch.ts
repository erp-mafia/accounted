import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'

/**
 * The daily reminder batch (accounted#104, phase 2): once a day, per company
 * that turned reminders on, the reminders due today are staged as ONE
 * pending operation, reminder_daily_batch, for a person to review in Att
 * göra. Shared by the cron that stages it (gather.ts), the commit
 * (batch-commit.ts), the review route (/api/pending-operations/[id]/items)
 * and the review dialog. Pure and client-safe.
 *
 * Nothing reaches a customer before an owner or administrator approved the
 * batch in the web UI. Every item is decided again at the send
 * (dispatch.ts): a batch approved in the afternoon sends nothing for an
 * invoice paid at lunch.
 */

export const REMINDER_BATCH_TYPE = 'reminder_daily_batch' as const

/** The item kind on collection_batch_removals, the table both daily batches take items out through. */
export const REMINDER_BATCH_ITEM_KIND = 'reminder' as const

/**
 * The bank check when the batch was gathered. fresh: the account the
 * customer pays to synced within 24 hours and shows nothing that could be
 * this payment. stale or no_bank: nobody can tell, so the item goes out only
 * because the approver saw this and sent it anyway (never automatic).
 */
export const REMINDER_BATCH_BANK_STATES = ['fresh', 'stale', 'no_bank'] as const
export type ReminderBatchBankState = (typeof REMINDER_BATCH_BANK_STATES)[number]

/**
 * Overdue invoices on the ladder that get no reminder today and need a
 * person, each with a sentence in the review (reminders.batch_excluded_*).
 * Invoices that never join the ladder by themselves (imported, issued before
 * reminders were turned on) are not listed: a person reminds those from the
 * invoice.
 */
export const REMINDER_BATCH_EXCLUDED_REASONS = [
  /** An unbooked incoming payment may be this invoice's: match it. */
  'possible_payment',
  /** The customer answered a reminder ("Jag har betalat" or "Något stämmer inte"). */
  'response',
  /** A reminder bounced or was reported as spam. */
  'undelivered',
  /** A reminder could not be sent, or nobody knows whether it was. */
  'send_failed',
  /** Reminded by the old sender (before 2026-10): a person decides what comes next. */
  'earlier_reminders',
  /** The customer has no email address to remind. */
  'no_email',
  /** Accounted cannot show the customer received the invoice. */
  'not_delivered',
  /** All three reminders went out and the invoice is still owed. */
  'complete',
] as const
export type ReminderBatchExcludedReason = (typeof REMINDER_BATCH_EXCLUDED_REASONS)[number]

/** Why an approved item was not sent (reminders.batch_skip_*). */
export const REMINDER_BATCH_SKIP_REASONS = ['changed', 'paid', 'bank', 'failed', 'error'] as const
export type ReminderBatchSkipReason = (typeof REMINDER_BATCH_SKIP_REASONS)[number]

const levelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])

export const reminderBatchItemSchema = z.object({
  kind: z.literal(REMINDER_BATCH_ITEM_KIND),
  invoice_id: z.uuid(),
  invoice_number: z.string().nullable(),
  customer_name: z.string().nullable(),
  /** The customer's invoice address the reminder goes to (copies per the invoice settings come on top). */
  recipient: z.string(),
  due_date: isoDateSchema,
  level: levelSchema,
  /** What was left to pay when the batch was staged, in `currency`. */
  remaining_amount: z.number(),
  currency: z.string(),
  bank: z.enum(REMINDER_BATCH_BANK_STATES),
})
export type ReminderBatchItem = z.infer<typeof reminderBatchItemSchema>

export const reminderBatchExcludedSchema = z.object({
  invoice_id: z.uuid(),
  invoice_number: z.string().nullable(),
  customer_name: z.string().nullable(),
  due_date: isoDateSchema,
  reason: z.enum(REMINDER_BATCH_EXCLUDED_REASONS),
})
export type ReminderBatchExcluded = z.infer<typeof reminderBatchExcludedSchema>

export const reminderBatchParamsSchema = z.object({
  /** The day the batch was gathered (Europe/Stockholm). */
  batch_date: isoDateSchema,
  items: z.array(reminderBatchItemSchema),
  excluded: z.array(reminderBatchExcludedSchema),
})
export type ReminderBatchParams = z.infer<typeof reminderBatchParamsSchema>

export interface ReminderBatchSkip {
  invoice_id: string
  reason: ReminderBatchSkipReason
  /** The dispatch outcome behind it (a skip reason or a channel error code). */
  code: string
}

export interface ReminderBatchCommitResult {
  batch_date: string
  sent: Array<{ invoice_id: string; level: 1 | 2 | 3; reminder_id: string }>
  skipped: ReminderBatchSkip[]
  sent_count: number
  skipped_count: number
}

/** The staged items less the ones a person took out before approving (collection_batch_removals). */
export function remainingReminderItems(
  params: Pick<ReminderBatchParams, 'items'>,
  removedInvoiceIds: readonly string[],
): ReminderBatchItem[] {
  const out = new Set(removedInvoiceIds)
  return params.items.filter((item) => !out.has(item.invoice_id))
}

/** Swedish, as every staged operation's title (the /pending list is in Swedish). */
export function reminderBatchTitle(batchDate: string, count: number): string {
  return `Påminnelser ${batchDate}: ${count} ${count === 1 ? 'faktura' : 'fakturor'} att granska`
}
