/**
 * One acknowledgment for many routine high-risk operations (crm#1488, crm#1489).
 *
 * High risk keeps an operation out of bulk approval: each one is confirmed on
 * its own (risk-tiers.ts). That is right where the risk is the operation's
 * own (a link to an existing verifikat, a reviewed duplicate override, a
 * compliance warning), but an agent that books a Stripe connection proposes
 * one samlingsverifikat per day: 170 of the same kind, each needing its own
 * click. A group listed here may be approved in bulk under ONE explicit
 * acknowledgment that names the count, the amounts and the accounts the
 * selection posts to; everything else stays individual.
 *
 * A webshop store synced by an agent proposes one verifikat per order the
 * same way: 500 orders, each needing its own two clicks (I12, 2026-10-29).
 * Those join under the same kind of acknowledgment unless the order's
 * suggestion carried a warning (a country or VAT rate no store rule covers).
 *
 * The tier is unchanged on purpose: a new samlingsverifikat carries
 * caller-built lines, the create_voucher surface, so it stays 'high' (out of
 * cross-company batch staging and needing confirmed=true over the API). Only
 * the dashboard's bulk approval reads this file, and the bulk-commit route
 * re-derives the group from the stored operation: a client cannot widen it.
 */
import { chunk } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { PendingOperation } from '@/types'

/** The groups one acknowledgment may cover. */
export const SHARED_ACKNOWLEDGMENT_GROUPS = ['bulk_book_create_new', 'webshop_order_book'] as const

export type SharedAcknowledgmentGroup = (typeof SHARED_ACKNOWLEDGMENT_GROUPS)[number]

type GroupSource = Pick<PendingOperation, 'operation_type' | 'risk_level' | 'params' | 'preview_data'>

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The shared-acknowledgment group of a high-risk operation, or null when it
 * must be confirmed on its own:
 * - a link to an existing verifikat (the salary payout case): the amount
 *   match against one posted voucher is the thing to check, one by one;
 * - a reviewed duplicate override (force): each dismissal is its own call;
 * - any compliance or VAT warning on the proposal;
 * - a webshop order whose suggestion warned (foreign VAT, a country outside
 *   Sweden no rule covers, an unsupported rate): its accounts need a look.
 */
export function sharedAcknowledgmentGroup(op: GroupSource): SharedAcknowledgmentGroup | null {
  if (op.risk_level !== 'high') return null
  if (op.operation_type === 'book_webshop_order') return webshopOrderGroup(op)
  if (op.operation_type !== 'bulk_book_transactions') return null
  const params = op.params ?? {}
  if (hasText(params.existing_journal_entry_id)) return null
  // allow_duplicate is the pre-upgrade name of force (operations/transactions.ts upgradeParams).
  if (params.force === true || params.allow_duplicate === true) return null
  const preview = op.preview_data ?? {}
  if (hasText(preview.compliance_warning)) return null
  if (Array.isArray(preview.vat_warnings) && preview.vat_warnings.length > 0) return null
  return 'bulk_book_create_new'
}

function webshopOrderGroup(op: GroupSource): SharedAcknowledgmentGroup | null {
  const preview = op.preview_data ?? {}
  if (hasText(preview.compliance_warning)) return null
  if (!Array.isArray(preview.warnings) || preview.warnings.length > 0) return null
  const entry = webshopEntryOf(preview)
  if (!entry || !Array.isArray(entry.lines) || entry.lines.length === 0) return null
  return 'webshop_order_book'
}

/** The verifikat a staged webshop order booking previews (webshop-orders/service.ts). */
function webshopEntryOf(preview: Record<string, unknown>): Record<string, unknown> | null {
  const entry = preview.journal_entry
  return entry != null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null
}

function toAmount(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(amount) ? amount : 0
}

export interface SharedAcknowledgmentAccount {
  account_number: string
  account_name: string | null
  debit: number
  credit: number
}

export interface SharedAcknowledgmentSummary {
  count: number
  /** Earliest and latest bank-row (or webshop verifikat) date the selection books. */
  date_from: string | null
  date_to: string | null
  /** Sum of the incoming rows (webshop: the orders), SEK. */
  incoming: number
  /** Sum of the outgoing rows (webshop: the refunds) as a positive amount, SEK. */
  outgoing: number
  /** Every account the selection posts to, with its summed debit and credit. */
  accounts: SharedAcknowledgmentAccount[]
}

/**
 * What one acknowledgment approves, summed from the operations' previews:
 * the person confirms this, not 170 titles. Amounts in kronor, rounded to
 * öre after every addition; account numbers stay strings.
 */
export function summarizeSharedAcknowledgment(
  ops: ReadonlyArray<Pick<PendingOperation, 'preview_data'>>,
): SharedAcknowledgmentSummary {
  let incoming = 0
  let outgoing = 0
  let dateFrom: string | null = null
  let dateTo: string | null = null
  const accounts = new Map<string, SharedAcknowledgmentAccount>()

  for (const op of ops) {
    const preview = op.preview_data ?? {}
    // A webshop order booking previews its verifikat under journal_entry and
    // its signed amount (a refund is negative) as total_sek; a bank booking
    // previews the bank rows' sum and dates and the lines at the top level.
    const entry = webshopEntryOf(preview)
    const sum = toAmount(entry ? preview.total_sek : preview.tx_sum)
    if (sum >= 0) incoming = roundOre(incoming + sum)
    else outgoing = roundOre(outgoing - sum)

    const dates = entry ? [entry.entry_date] : [preview.tx_date, preview.tx_date_to]
    for (const raw of dates) {
      if (typeof raw !== 'string' || raw === '') continue
      if (dateFrom === null || raw < dateFrom) dateFrom = raw
      if (dateTo === null || raw > dateTo) dateTo = raw
    }

    const source = entry ? entry.lines : preview.lines
    const lines = Array.isArray(source) ? (source as Array<Record<string, unknown>>) : []
    for (const line of lines) {
      if (line == null || line.account_number == null) continue
      const accountNumber = String(line.account_number)
      const entry = accounts.get(accountNumber) ?? {
        account_number: accountNumber,
        account_name: typeof line.account_name === 'string' ? line.account_name : null,
        debit: 0,
        credit: 0,
      }
      entry.debit = roundOre(entry.debit + toAmount(line.debit_amount))
      entry.credit = roundOre(entry.credit + toAmount(line.credit_amount))
      accounts.set(accountNumber, entry)
    }
  }

  return {
    count: ops.length,
    date_from: dateFrom,
    date_to: dateTo,
    incoming,
    outgoing,
    accounts: [...accounts.values()].sort((a, b) => a.account_number.localeCompare(b.account_number)),
  }
}

/** The most ids the bulk routes accept per request (PendingOperationsBulkSchema). */
export const BULK_IDS_MAX = 100

/**
 * The ids the page sends per bulk request. Below BULK_IDS_MAX so one request
 * stays well inside the route's 300 s budget: a batch of 100 bank bookings
 * took 90 s in production on 2026-10-26.
 */
export const BULK_CHUNK_SIZE = 50

/** Split ids into request-sized chunks, in order. */
export function chunkIds<T>(ids: readonly T[], size: number = BULK_CHUNK_SIZE): T[][] {
  return chunk(ids, size)
}
