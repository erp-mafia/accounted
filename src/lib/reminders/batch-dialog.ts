import {
  REMINDER_BATCH_EXCLUDED_REASONS,
  REMINDER_BATCH_SKIP_REASONS,
  REMINDER_BATCH_TYPE,
  remainingReminderItems,
  type ReminderBatchBankState,
  type ReminderBatchCommitResult,
  type ReminderBatchExcluded,
  type ReminderBatchExcludedReason,
  type ReminderBatchItem,
  type ReminderBatchSkip,
  type ReminderBatchSkipReason,
} from './batch'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { BATCH_REVIEW_QUERY } from '@/lib/collections/batch-dialog'
import { sumOre } from '@/lib/money'

/**
 * The daily reminder batch's review dialog (accounted#104, phase 2), pure
 * and client-safe so the dialog, its tests, the Att göra count and /pending
 * share one reading: which sentence each left-out invoice and each skip
 * reads, which bank warning a row carries, what the person left ticked and
 * what that adds up to per currency, and how the commit's answer reads. The
 * commit decides every item again at the send; this only keeps the dialog
 * honest.
 */

/** GET or PATCH /api/pending-operations/[id]/items for a reminder_daily_batch. */
export interface ReminderBatchView {
  id: string
  status: string
  created_at: string
  /** The day the batch was gathered (Europe/Stockholm). */
  batch_date: string
  /** The staged items less the ones a person took out. */
  items: ReminderBatchItem[]
  excluded: ReminderBatchExcluded[]
  removed_invoice_ids: string[]
}

/** The sentence for why an overdue invoice gets no reminder today (reminders.batch_excluded_*). */
export const REMINDER_EXCLUDED_REASON_KEY: Record<ReminderBatchExcludedReason, string> = {
  possible_payment: 'batch_excluded_possible_payment',
  response: 'batch_excluded_response',
  undelivered: 'batch_excluded_undelivered',
  send_failed: 'batch_excluded_send_failed',
  earlier_reminders: 'batch_excluded_earlier_reminders',
  no_email: 'batch_excluded_no_email',
  not_delivered: 'batch_excluded_not_delivered',
  complete: 'batch_excluded_complete',
}

/** The sentence for why an approved reminder was not sent (reminders.batch_skip_*). */
export const REMINDER_SKIP_REASON_KEY: Record<ReminderBatchSkipReason, string> = {
  changed: 'batch_skip_changed',
  paid: 'batch_skip_paid',
  bank: 'batch_skip_bank',
  failed: 'batch_skip_failed',
  error: 'batch_skip_error',
}

/** The reminder's name per level, as the email's subject and the invoice page call it (reminders.batch_level_*). */
export function reminderLevelKey(level: ReminderBatchItem['level']): 'batch_level_1' | 'batch_level_2' | 'batch_level_3' {
  return `batch_level_${level}`
}

/**
 * A row's bank warning: the bank could not show the invoice is still unpaid,
 * and approving sends the reminder anyway. Null when the bank was checked.
 */
const ROW_BANK_WARNING_KEY: Record<ReminderBatchBankState, string | null> = {
  fresh: null,
  stale: 'batch_bank_stale',
  no_bank: 'batch_bank_none',
}

/** The same warning said once for the whole batch. */
const ALL_BANK_WARNING_KEY: Record<ReminderBatchBankState, string | null> = {
  fresh: null,
  stale: 'batch_bank_stale_all',
  no_bank: 'batch_bank_none_all',
}

export interface BankWarnings {
  /** Every item carries the same warning (a company without a connected bank): one sentence above the table. */
  allKey: string | null
  /** Otherwise each warned row's own sentence, by invoice id. */
  rowKeys: Map<string, string>
}

/**
 * Which bank warnings the review shows. A chip on every row says nothing
 * (design convention 5), so a warning the whole batch shares is said once;
 * rows that differ from the rest carry their own.
 */
export function bankWarnings(items: ReadonlyArray<Pick<ReminderBatchItem, 'invoice_id' | 'bank'>>): BankWarnings {
  const states = [...new Set(items.map((item) => item.bank))]
  const allKey = states.length === 1 ? ALL_BANK_WARNING_KEY[states[0]] : null
  if (allKey) return { allKey, rowKeys: new Map() }
  const rowKeys = new Map<string, string>()
  for (const item of items) {
    const key = ROW_BANK_WARNING_KEY[item.bank]
    if (key) rowKeys.set(item.invoice_id, key)
  }
  return { allKey: null, rowKeys }
}

type Ordered = { due_date: string; invoice_number: string | null }

/** The longest overdue first; the same due date by invoice number. */
function oldestDueFirst(a: Ordered, b: Ordered): number {
  return a.due_date.localeCompare(b.due_date) || (a.invoice_number ?? '').localeCompare(b.invoice_number ?? '', 'sv-SE', { numeric: true })
}

/** The items in the order the review lists them. */
export function sortReminderItems(items: readonly ReminderBatchItem[]): ReminderBatchItem[] {
  return [...items].sort(oldestDueFirst)
}

/** The left-out invoices by reason as listed in REMINDER_BATCH_EXCLUDED_REASONS, then the longest overdue first. */
export function sortReminderExcluded(rows: readonly ReminderBatchExcluded[]): ReminderBatchExcluded[] {
  const rank = (reason: ReminderBatchExcludedReason) => REMINDER_BATCH_EXCLUDED_REASONS.indexOf(reason)
  return [...rows].sort((a, b) => rank(a.reason) - rank(b.reason) || oldestDueFirst(a, b))
}

/**
 * The items still ticked: what the approval sends. An invoice is in a
 * reminder batch once, so the unticked keys are invoice ids
 * (toggleUnticked from the collections dialog keeps them).
 */
export function tickedReminderItems(items: readonly ReminderBatchItem[], unticked: readonly string[]): ReminderBatchItem[] {
  const out = new Set(unticked)
  return items.filter((item) => !out.has(item.invoice_id))
}

/**
 * The invoices to take out of the batch before it is approved (PATCH
 * remove_invoice_ids): the unticked ones still in it. Empty when nothing was
 * unticked. Removal is final, so the dialog sends it only with the approval.
 */
export function reminderRemovalIds(items: readonly ReminderBatchItem[], unticked: readonly string[]): string[] {
  const ids = new Set(items.map((item) => item.invoice_id))
  return [...new Set(unticked)].filter((id) => ids.has(id))
}

export interface CurrencyTotal {
  currency: string
  amount: number
}

/**
 * What is left to pay across the ticked items, per currency: kronor and
 * euro never add up. The ledger currency first, then by currency code.
 * Display only.
 */
export function tickedReminderTotals(items: readonly ReminderBatchItem[], unticked: readonly string[]): CurrencyTotal[] {
  const perCurrency = new Map<string, number[]>()
  for (const item of tickedReminderItems(items, unticked)) {
    perCurrency.set(item.currency, [...(perCurrency.get(item.currency) ?? []), item.remaining_amount])
  }
  const ledgerFirst = (total: CurrencyTotal) => (isLedgerCurrency(total.currency) ? 0 : 1)
  return [...perCurrency.entries()]
    .map(([currency, amounts]) => ({ currency, amount: sumOre(amounts) }))
    .sort((a, b) => ledgerFirst(a) - ledgerFirst(b) || a.currency.localeCompare(b.currency))
}

/**
 * Whether "Skicka" is enabled: the batch is still pending and at least one
 * reminder is ticked (a batch with nothing to send is rejected instead). No
 * typed confirmation word: a reminder is lighter than an inkasso step.
 */
export function reminderBatchCanSend(state: { status: string; ticked: number }): boolean {
  return state.status === 'pending' && state.ticked > 0
}

export interface ReminderSkipLine {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  /** reminders.batch_skip_* */
  reasonKey: string
}

/** The commit's skips with the invoice number and customer the dialog showed, in the dialog's order. */
export function reminderSkipLines(result: Pick<ReminderBatchCommitResult, 'skipped'>, shown: readonly ReminderBatchItem[]): ReminderSkipLine[] {
  const byId = new Map(shown.map((item, index) => [item.invoice_id, { item, index }]))
  const rank = (skip: ReminderBatchSkip) => byId.get(skip.invoice_id)?.index ?? Number.MAX_SAFE_INTEGER
  return [...result.skipped]
    .sort((a, b) => rank(a) - rank(b))
    .map((skip) => {
      const item = byId.get(skip.invoice_id)?.item
      return {
        invoice_id: skip.invoice_id,
        invoice_number: item?.invoice_number ?? null,
        customer_name: item?.customer_name ?? null,
        reasonKey: REMINDER_SKIP_REASON_KEY[skip.reason] ?? REMINDER_SKIP_REASON_KEY.error,
      }
    })
}

function isSkipReason(value: unknown): value is ReminderBatchSkipReason {
  return (REMINDER_BATCH_SKIP_REASONS as readonly unknown[]).includes(value)
}

function hasInvoiceId(value: unknown): value is { invoice_id: string } {
  return !!value && typeof value === 'object' && typeof (value as { invoice_id?: unknown }).invoice_id === 'string'
}

/**
 * The commit's answer ({ data: ReminderBatchCommitResult }), read
 * defensively: a missing or odd field reads as nothing sent rather than a
 * crash, and an unknown skip reason reads as our own error.
 */
export function parseReminderBatchResult(json: unknown): ReminderBatchCommitResult | null {
  const raw = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined
  if (!raw || typeof raw !== 'object') return null
  const answer = raw as Partial<Record<keyof ReminderBatchCommitResult, unknown>>
  const sent = (Array.isArray(answer.sent) ? answer.sent : []).filter(hasInvoiceId) as ReminderBatchCommitResult['sent']
  const skipped: ReminderBatchSkip[] = (Array.isArray(answer.skipped) ? answer.skipped : []).filter(hasInvoiceId).map((skip) => {
    const { reason, code } = skip as { reason?: unknown; code?: unknown }
    return { invoice_id: skip.invoice_id, reason: isSkipReason(reason) ? reason : 'error', code: typeof code === 'string' ? code : '' }
  })
  return {
    batch_date: typeof answer.batch_date === 'string' ? answer.batch_date : '',
    sent,
    skipped,
    sent_count: typeof answer.sent_count === 'number' ? answer.sent_count : sent.length,
    skipped_count: typeof answer.skipped_count === 'number' ? answer.skipped_count : skipped.length,
  }
}

/** The /pending deep link the Att göra row opens: the page opens the pending reminder batch's dialog. */
export const REMINDER_BATCH_REVIEW_HREF = `/pending?${BATCH_REVIEW_QUERY}=${REMINDER_BATCH_TYPE}`

/** Whether a /pending URL asks for the reminder batch dialog. */
export function wantsReminderBatchReview(search: string): boolean {
  return new URLSearchParams(search).get(BATCH_REVIEW_QUERY) === REMINDER_BATCH_TYPE
}

/**
 * The batch's items from a pending operation's params, less the ones taken
 * out; [] when they cannot be read. For the counts and row titles that read
 * the operation itself (the dialog reads the items route).
 */
export function reminderRunItems(params: unknown, removedInvoiceIds: readonly string[] = []): ReminderBatchItem[] {
  const raw = params && typeof params === 'object' ? (params as { items?: unknown }).items : undefined
  const items = (Array.isArray(raw) ? raw : []).filter(hasInvoiceId) as ReminderBatchItem[]
  return remainingReminderItems({ items }, removedInvoiceIds)
}
