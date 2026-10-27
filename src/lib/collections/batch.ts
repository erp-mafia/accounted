import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'
import { DAILY_BATCH_EXPIRY_HOURS } from '@/lib/pending-operations/daily-batch-staging'

/**
 * The daily collections batch (build spec 3.6): the shape of the one staged
 * pending operation a company gets per day, shared by the cron that stages
 * it (autopilot.ts), the commit (batch-commit.ts), the review route
 * (/api/pending-operations/[id]/items) and the review dialog. Pure and
 * client-safe.
 *
 * Nothing in the batch reaches a customer before an administrator approved
 * it in the web UI: no timer, no auto-approve, no "send unless stopped".
 */

export const COLLECTIONS_BATCH_TYPE = 'collections_daily_batch' as const

/** The cron rejects its own batch once it has waited this long (the generic expiry waits 30 days). */
export const BATCH_EXPIRY_HOURS = DAILY_BATCH_EXPIRY_HOURS

/**
 * open          a new handover of an overdue invoice
 * start         reminders on an invoice the provider only delivered (a watching case)
 * approve_step  the reminder or collection notice a case waits for approval of
 */
export const BATCH_ITEM_KINDS = ['open', 'start', 'approve_step'] as const
export type BatchItemKind = (typeof BATCH_ITEM_KINDS)[number]

/** Why an overdue invoice is not in the batch. Each has a sentence (collections.batch_excluded_*). */
export const BATCH_EXCLUDED_REASONS = [
  /** The account the customer pays to was not synced in the last 24 hours (or none is connected). */
  'bank_stale',
  /** An unbooked incoming payment may be this invoice's. */
  'candidates',
  /** Created in an earlier system: only a person hands it over, from the invoice. */
  'imported',
  /** Accounted cannot show the customer received the invoice. */
  'not_delivered',
  /** The customer answered a reminder (disputed or says paid). */
  'response',
  /** Below the company's minimum amount for collection. */
  'below_minimum',
  /** The customer is marked "Skicka aldrig till inkasso". */
  'customer_excluded',
  /** Any other requirement the invoice fails (block names it). */
  'ineligible',
] as const
export type BatchExcludedReason = (typeof BATCH_EXCLUDED_REASONS)[number]

/**
 * Why an approved item was not sent. One reason per skip (collections.batch_skip_*):
 * the amount changed, a new payment or a stale bank, no longer eligible, the
 * provider did not answer, or an error of our own.
 */
export const BATCH_SKIP_REASONS = ['changed', 'bank', 'ineligible', 'connector', 'error'] as const
export type BatchSkipReason = (typeof BATCH_SKIP_REASONS)[number]

const isoDate = isoDateSchema

export const batchItemSchema = z.object({
  kind: z.enum(BATCH_ITEM_KINDS),
  invoice_id: z.uuid(),
  /** The open case for start and approve_step; null for open (its case id is derived at commit). */
  case_id: z.uuid().nullable(),
  invoice_number: z.string().nullable(),
  customer_name: z.string().nullable(),
  due_date: isoDate,
  /** What is still owed (the customer's share) when the batch was staged; a change skips the item. */
  remaining_amount: z.number(),
  /** Where the provider begins (open, start); null for approve_step. */
  start_step: z.enum(['reminder', 'collection']).nullable(),
  /** The decision an approve_step item answers. */
  decision_kind: z.enum(['approve_reminder', 'approve_collection_notice']).nullable(),
  /** A reminder fee agreed for this invoice; null where it does not apply (approve_step). */
  reminder_fee_agreed: z.boolean().nullable(),
  /** Only items whose bank check passed are staged. */
  bank_check: z.literal('pass'),
})
export type BatchItem = z.infer<typeof batchItemSchema>

export const batchExcludedSchema = z.object({
  kind: z.enum(BATCH_ITEM_KINDS),
  invoice_id: z.uuid(),
  invoice_number: z.string().nullable(),
  customer_name: z.string().nullable(),
  due_date: isoDate.nullable(),
  reason: z.enum(BATCH_EXCLUDED_REASONS),
  /** The first failed requirement for reason 'ineligible' (an eligibility block code). */
  block: z.string().nullable(),
})
export type BatchExcluded = z.infer<typeof batchExcludedSchema>

export const batchParamsSchema = z.object({
  /** The day the batch was gathered (Europe/Stockholm). */
  batch_date: isoDate,
  connection_id: z.uuid(),
  items: z.array(batchItemSchema),
  excluded: z.array(batchExcludedSchema),
})
export type BatchParams = z.infer<typeof batchParamsSchema>

export interface BatchSkip {
  invoice_id: string
  kind: BatchItemKind
  reason: BatchSkipReason
  /** The refusal behind the reason (a structured-error code). */
  code: string
}

export interface BatchCommitResult {
  batch_date: string
  done: Array<{ invoice_id: string; kind: BatchItemKind; case_id: string | null }>
  skipped: BatchSkip[]
  done_count: number
  skipped_count: number
}

/**
 * The one reason a refused item was skipped for. A payment meanwhile, an
 * unreported payment or a stale bank all read "Ny inbetalning eller inaktuell
 * bank"; the provider's own failure reads as the provider not answering;
 * everything else no longer meets the requirements.
 */
export function batchSkipReason(code: string, details?: Record<string, unknown>, upstream = false): BatchSkipReason {
  // The case no longer offers the step: it moved on since the morning.
  if (code === 'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE') return 'ineligible'
  if (upstream) return 'connector'
  switch (code) {
    case 'COLLECTION_REMAINING_CHANGED':
      return 'changed'
    case 'COLLECTION_BANK_CANDIDATES':
    case 'COLLECTION_BANK_STALE':
    case 'COLLECTION_PAYMENT_NOT_REPORTED':
      return 'bank'
    case 'COLLECTION_ATTESTATION_REQUIRED': {
      const missing = Array.isArray(details?.attestations) ? (details.attestations as unknown[]) : []
      return missing.length > 0 && missing.every((m) => m === 'bank') ? 'bank' : 'ineligible'
    }
    case 'COLLECTIONS_UNAVAILABLE':
      return 'connector'
    case 'INTERNAL_ERROR':
      return 'error'
    default:
      return 'ineligible'
  }
}

/** One item an administrator took out of the batch before approving it (collection_batch_removals). */
export interface BatchRemoval {
  invoice_id: string
  kind: BatchItemKind
}

/**
 * The staged items less the ones taken out ("Bocka ur dem du inte vill
 * skicka"). The staged params are frozen; removals live beside them, so
 * nothing can be added to a batch after it was staged.
 */
export function remainingBatchItems(params: Pick<BatchParams, 'items'>, removals: readonly BatchRemoval[]): BatchItem[] {
  const out = new Set(removals.map((r) => `${r.kind}:${r.invoice_id}`))
  return params.items.filter((item) => !out.has(`${item.kind}:${item.invoice_id}`))
}

/** The word an administrator types to approve a batch (the dialog's typed confirmation). */
export const BATCH_CONFIRMATION_WORD = 'skicka'

export function batchConfirmationMatches(typed: string): boolean {
  return typed.trim().toLocaleLowerCase('sv-SE') === BATCH_CONFIRMATION_WORD
}

/**
 * The two collections rows of Att göra count an invoice once. A decision
 * the pending batch proposes (an approve_step item still in it) belongs to
 * the batch row: the batch is where it is proposed with the morning's bank
 * check, and approving the batch sends it. The decision row counts the cases
 * waiting for a decision outside the batch (a dispute, the customer's
 * "already paid", or a step taken out of the batch, which goes back to it).
 */
export function collectionWorkCounts(
  decisionCaseIds: readonly string[],
  batchItems: readonly BatchItem[],
  removals: readonly BatchRemoval[],
): { decision: number; batchReady: number } {
  const remaining = remainingBatchItems({ items: [...batchItems] }, removals)
  const proposed = new Set(remaining.filter((item) => item.kind === 'approve_step' && item.case_id).map((item) => item.case_id))
  return {
    decision: decisionCaseIds.filter((id) => !proposed.has(id)).length,
    batchReady: remaining.length,
  }
}
