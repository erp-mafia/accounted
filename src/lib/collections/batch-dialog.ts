import {
  BATCH_ITEM_KINDS,
  COLLECTIONS_BATCH_TYPE,
  BATCH_SKIP_REASONS,
  batchConfirmationMatches,
  type BatchCommitResult,
  type BatchExcluded,
  type BatchExcludedReason,
  type BatchItem,
  type BatchItemKind,
  type BatchRemoval,
  type BatchSkipReason,
} from './batch'
import { sumOre } from '@/lib/money'
import type { EligibilityBlockCode } from './eligibility'

/**
 * The daily batch review dialog's decisions (build spec 3.6), pure and
 * client-safe so the dialog and its tests share them: how the items group
 * per kind, which sentence each excluded row and each skip reads, what the
 * person has left ticked, whether the batch may be sent, and how the
 * commit's answer reads. The server decides every item again at commit;
 * this only keeps the dialog honest.
 */

/** GET or PATCH /api/pending-operations/[id]/items. */
export interface BatchView {
  id: string
  status: string
  created_at: string
  batch_date: string
  items: BatchItem[]
  excluded: BatchExcluded[]
  removed: BatchRemoval[]
}

export interface BatchItemGroup {
  kind: BatchItemKind
  /** collections.batch_kind_* */
  labelKey: 'batch_kind_open' | 'batch_kind_start' | 'batch_kind_approve'
  items: BatchItem[]
}

const KIND_LABEL: Record<BatchItemKind, BatchItemGroup['labelKey']> = {
  open: 'batch_kind_open',
  start: 'batch_kind_start',
  approve_step: 'batch_kind_approve',
}

/** Oldest due date first, then by invoice number, so the longest overdue reads first. */
function byDueDate(a: { due_date: string | null; invoice_number: string | null }, b: { due_date: string | null; invoice_number: string | null }): number {
  const due = (a.due_date ?? '').localeCompare(b.due_date ?? '')
  if (due !== 0) return due
  return (a.invoice_number ?? '').localeCompare(b.invoice_number ?? '', 'sv-SE', { numeric: true })
}

/** The items per kind (new handovers, reminders on delivered invoices, next steps to approve); empty kinds left out. */
export function groupBatchItems(items: readonly BatchItem[]): BatchItemGroup[] {
  return BATCH_ITEM_KINDS.map((kind) => ({
    kind,
    labelKey: KIND_LABEL[kind],
    items: items.filter((item) => item.kind === kind).sort(byDueDate),
  })).filter((group) => group.items.length > 0)
}

/** One item's identity in the dialog: the same invoice is never two kinds at once, but the key says both. */
export function batchItemKey(item: Pick<BatchItem, 'kind' | 'invoice_id'>): string {
  return `${item.kind}:${item.invoice_id}`
}

/** Tick or untick an item ("Bocka ur dem du inte vill skicka"). */
export function toggleUnticked(unticked: readonly string[], key: string): string[] {
  return unticked.includes(key) ? unticked.filter((k) => k !== key) : [...unticked, key]
}

/** The items still ticked: what the batch sends when the person approves. */
export function tickedItems(items: readonly BatchItem[], unticked: readonly string[]): BatchItem[] {
  return items.filter((item) => !unticked.includes(batchItemKey(item)))
}

/**
 * The invoices to take out of the batch before it is approved (PATCH
 * remove_invoice_ids). Empty when nothing was unticked. Removal is final:
 * the dialog sends it only together with the approval.
 */
export function removalInvoiceIds(items: readonly BatchItem[], unticked: readonly string[]): string[] {
  const ids = items.filter((item) => unticked.includes(batchItemKey(item))).map((item) => item.invoice_id)
  return [...new Set(ids)]
}

/** The sum still owed across the ticked items. Display only. */
export function tickedTotal(items: readonly BatchItem[], unticked: readonly string[]): number {
  return sumOre(tickedItems(items, unticked).map((item) => item.remaining_amount))
}

export interface BatchSendState {
  status: string
  ticked: number
  typed: string
}

/**
 * Whether "Skicka" is enabled: the batch is still pending, at least one item
 * is ticked (a batch with nothing to send is rejected instead), and the
 * person typed the confirmation word.
 */
export function batchCanSend(state: BatchSendState): boolean {
  return state.status === 'pending' && state.ticked > 0 && batchConfirmationMatches(state.typed)
}

/** The sentence for why an overdue invoice is not in the batch (collections.batch_excluded_*). */
export const EXCLUDED_REASON_KEY: Record<BatchExcludedReason, string> = {
  bank_stale: 'batch_excluded_bank',
  candidates: 'batch_excluded_candidates',
  imported: 'batch_excluded_imported',
  not_delivered: 'batch_excluded_not_delivered',
  response: 'batch_excluded_response',
  below_minimum: 'batch_excluded_below_minimum',
  customer_excluded: 'batch_excluded_customer_excluded',
  ineligible: 'batch_excluded_ineligible',
}

/** Eligibility blocks whose collections sentence reads without values (elig_below_minimum needs an amount; it has its own reason). */
export const BLOCK_SENTENCES: ReadonlySet<string> = new Set<EligibilityBlockCode | 'payment_not_reported'>([
  'elig_not_invoice',
  'elig_credit_note',
  'elig_credit_draft',
  'elig_credited',
  'elig_not_sent',
  'elig_paid',
  'elig_not_overdue',
  'elig_currency',
  'elig_foreign',
  'elig_private_unsupported',
  'elig_open_case',
  'elig_time_barred',
  'elig_rot_rut_reclaimed',
  'elig_minor',
  'debtor_missing_customer',
  'debtor_missing_address',
  'debtor_missing_org_number',
  'debtor_invalid_org_number',
  'debtor_excluded',
])

export interface ExcludedLine {
  /** collections.batch_excluded_* */
  reasonKey: string
  /**
   * For 'ineligible': the collections key naming the first failed
   * requirement, when it reads on its own. The dialog shows it in place of
   * the general sentence.
   */
  detailKey: string | null
}

export function excludedLine(row: Pick<BatchExcluded, 'reason' | 'block'>): ExcludedLine {
  const reasonKey = EXCLUDED_REASON_KEY[row.reason]
  if (row.reason !== 'ineligible' || !row.block) return { reasonKey, detailKey: null }
  if (row.block === 'payment_not_reported') return { reasonKey, detailKey: 'batch_excluded_payment_not_reported' }
  return { reasonKey, detailKey: BLOCK_SENTENCES.has(row.block) ? row.block : null }
}

/** Excluded rows in a stable order: by reason as listed, then the longest overdue first. */
export function sortExcluded(rows: readonly BatchExcluded[]): BatchExcluded[] {
  const order = Object.keys(EXCLUDED_REASON_KEY)
  return [...rows].sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason) || byDueDate(a, b))
}

/** The sentence for why an approved item was not sent (collections.batch_skip_*). */
export const SKIP_REASON_KEY: Record<BatchSkipReason, string> = {
  changed: 'batch_skip_changed',
  bank: 'batch_skip_bank',
  ineligible: 'batch_skip_ineligible',
  connector: 'batch_skip_connector',
  error: 'batch_skip_error',
}

export interface SkipLine {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  reasonKey: string
}

/** The commit's skips with the invoice number and customer the dialog showed, in the dialog's order. */
export function skipLines(result: Pick<BatchCommitResult, 'skipped'>, items: readonly BatchItem[]): SkipLine[] {
  const byKey = new Map(items.map((item) => [batchItemKey(item), item]))
  const position = new Map(items.map((item, index) => [batchItemKey(item), index]))
  return [...result.skipped]
    .sort((a, b) => (position.get(batchItemKey(a)) ?? Infinity) - (position.get(batchItemKey(b)) ?? Infinity))
    .map((skip) => {
      const item = byKey.get(batchItemKey(skip))
      return {
        invoice_id: skip.invoice_id,
        invoice_number: item?.invoice_number ?? null,
        customer_name: item?.customer_name ?? null,
        reasonKey: SKIP_REASON_KEY[skip.reason] ?? SKIP_REASON_KEY.error,
      }
    })
}

/**
 * The commit's answer ({ data: BatchCommitResult }), read defensively: a
 * missing or odd field reads as nothing done rather than a crash, and an
 * unknown skip reason reads as our own error.
 */
export function parseBatchResult(json: unknown): BatchCommitResult | null {
  const data = (json as { data?: unknown } | null)?.data as Partial<BatchCommitResult> | undefined
  if (!data || typeof data !== 'object') return null
  const done = Array.isArray(data.done) ? data.done.filter((d) => d && typeof d.invoice_id === 'string') : []
  const skipped = Array.isArray(data.skipped)
    ? data.skipped
        .filter((s) => s && typeof s.invoice_id === 'string')
        .map((s) => ({
          ...s,
          reason: (BATCH_SKIP_REASONS as readonly string[]).includes(s.reason) ? s.reason : ('error' as const),
        }))
    : []
  return {
    batch_date: typeof data.batch_date === 'string' ? data.batch_date : '',
    done,
    skipped,
    done_count: typeof data.done_count === 'number' ? data.done_count : done.length,
    skipped_count: typeof data.skipped_count === 'number' ? data.skipped_count : skipped.length,
  }
}

/** The /pending deep link the Att göra row opens: the page opens the pending batch's review dialog. */
export const BATCH_REVIEW_QUERY = 'review'
export const BATCH_REVIEW_HREF = `/pending?${BATCH_REVIEW_QUERY}=collections_daily_batch`

/** Whether a /pending URL asks for the batch dialog. */
export function wantsBatchReview(search: string): boolean {
  return new URLSearchParams(search).get(BATCH_REVIEW_QUERY) === 'collections_daily_batch'
}

// ---------------------------------------------------------------------------
// The daily run in Att göra and on /pending (a collections row, not an agent proposal)
// ---------------------------------------------------------------------------

/**
 * The step an item proposes: a new handover or a reminder start names its
 * first step; a next step to approve is the reminder or the inkassokrav the
 * provider waits to send.
 */
export function batchItemStep(item: Pick<BatchItem, 'kind' | 'start_step' | 'decision_kind'>): 'reminder' | 'collection' {
  if (item.kind === 'approve_step') return item.decision_kind === 'approve_reminder' ? 'reminder' : 'collection'
  return item.start_step === 'collection' ? 'collection' : 'reminder'
}

/**
 * The run's row in owner words ("3 förfallna fakturor föreslås för
 * påminnelse"): the step every remaining item proposes, or "inkasso" when
 * they differ. The i18n key (collections namespace) takes `count`.
 */
export function batchRowKey(items: ReadonlyArray<Pick<BatchItem, 'kind' | 'start_step' | 'decision_kind'>>): 'batch_row_reminder' | 'batch_row_collection' | 'batch_row_mixed' {
  const steps = new Set(items.map(batchItemStep))
  if (steps.size === 1) return steps.has('reminder') ? 'batch_row_reminder' : 'batch_row_collection'
  return items.length === 0 ? 'batch_row_reminder' : 'batch_row_mixed'
}

/** A pending operation is the daily collections run: reviewed in its own dialog, never framed as an agent proposal. */
export function isCollectionsRun(op: { operation_type: string; status: string }): boolean {
  return op.operation_type === COLLECTIONS_BATCH_TYPE && op.status === 'pending'
}

/** The run's items from a pending operation's params, less the ones taken out; [] when they cannot be read. */
export function runItems(params: unknown, removedInvoiceIds: readonly string[] = []): BatchItem[] {
  const items = (params as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  return (items as BatchItem[]).filter((item) => item && typeof item === 'object' && !removedInvoiceIds.includes(item.invoice_id))
}
