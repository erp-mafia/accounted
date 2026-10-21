import { isDigitalMailboxProvider, type DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'
import type { InvoiceStatus } from '@/types'

/**
 * The invoice detail page's view of its digital mailbox channels: what
 * GET /api/invoices/{id}/digital-mailbox answers, which "Skicka till
 * Kivra/Billo" items that makes, and the dispatches merged into the
 * delivery history. Client-safe; the send itself is
 * lib/invoices/digital-mailbox-send.ts.
 */

export interface InvoiceMailboxOptionView {
  provider: DigitalMailboxProviderId
  available: boolean
  /** The structured error code that blocks it, null when available. */
  reason: string | null
}

export interface MailboxDispatchView {
  id: string
  provider: DigitalMailboxProviderId
  status: 'sent' | 'failed'
  error_code: string | null
  created_at: string
}

export interface InvoiceMailboxView {
  options: InvoiceMailboxOptionView[]
  dispatches: MailboxDispatchView[]
}

export const EMPTY_INVOICE_MAILBOX_VIEW: InvoiceMailboxView = { options: [], dispatches: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The route's answer, keeping only well-formed rows. Anything else is the
 * empty view: the mailbox items and rows are supplementary, and the page
 * stays usable without them.
 */
export function parseInvoiceMailboxView(body: unknown): InvoiceMailboxView {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null
  if (!data) return EMPTY_INVOICE_MAILBOX_VIEW
  const options = Array.isArray(data.options)
    ? data.options.flatMap((row): InvoiceMailboxOptionView[] =>
        isRecord(row) && isDigitalMailboxProvider(row.provider) && typeof row.available === 'boolean'
          ? [{ provider: row.provider, available: row.available, reason: typeof row.reason === 'string' ? row.reason : null }]
          : [],
      )
    : []
  const dispatches = Array.isArray(data.dispatches)
    ? data.dispatches.flatMap((row): MailboxDispatchView[] =>
        isRecord(row) &&
        typeof row.id === 'string' &&
        isDigitalMailboxProvider(row.provider) &&
        (row.status === 'sent' || row.status === 'failed') &&
        typeof row.created_at === 'string'
          ? [
              {
                id: row.id,
                provider: row.provider,
                status: row.status,
                error_code: typeof row.error_code === 'string' ? row.error_code : null,
                created_at: row.created_at,
              },
            ]
          : [],
      )
    : []
  return { options, dispatches }
}

/** The statuses the send accepts: a draft (issued on the way) or an issued, unpaid invoice. */
export const MAILBOX_SENDABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  'draft',
  'sent',
  'overdue',
  'partially_paid',
])

/** Why an offered provider cannot take this invoice yet: the kundkort or the currency. */
export type MailboxSendBlock = 'recipient_unidentified' | 'currency'

export interface MailboxSendAction {
  provider: DigitalMailboxProviderId
  blockedBy: MailboxSendBlock | null
}

const FIXABLE_BLOCKS: Record<string, MailboxSendBlock> = {
  DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED: 'recipient_unidentified',
  DIGITAL_MAILBOX_CURRENCY_UNSUPPORTED: 'currency',
}

/**
 * One "Skicka till ..." item per provider the company sends through (the
 * route lists only those), while the invoice is in a sendable status. A
 * block the user can act on (no organisationsnummer or personnummer on the
 * kundkort, a foreign currency) keeps the item, disabled with why; any
 * other refusal (a kreditfaktura, a quote) has no item.
 */
export function mailboxSendActions(
  status: InvoiceStatus,
  options: readonly InvoiceMailboxOptionView[],
): MailboxSendAction[] {
  if (!MAILBOX_SENDABLE_STATUSES.has(status)) return []
  return options.flatMap((option): MailboxSendAction[] => {
    if (option.available) return [{ provider: option.provider, blockedBy: null }]
    const block = option.reason ? FIXABLE_BLOCKS[option.reason] : undefined
    return block ? [{ provider: option.provider, blockedBy: block }] : []
  })
}

export type DeliveryHistoryEntry<D> =
  | { kind: 'delivery'; at: string; delivery: D }
  | { kind: 'mailbox'; at: string; dispatch: MailboxDispatchView }

/**
 * The email deliveries and the mailbox dispatches as one history, newest
 * first. A timestamp that does not parse sorts last; on a tie the order the
 * rows arrived in holds, deliveries before dispatches.
 */
export function mergeDeliveryHistory<D>(
  deliveries: readonly D[],
  deliveryAt: (delivery: D) => string,
  dispatches: readonly MailboxDispatchView[],
): DeliveryHistoryEntry<D>[] {
  const entries: DeliveryHistoryEntry<D>[] = [
    ...deliveries.map((delivery) => ({ kind: 'delivery' as const, at: deliveryAt(delivery), delivery })),
    ...dispatches.map((dispatch) => ({ kind: 'mailbox' as const, at: dispatch.created_at, dispatch })),
  ]
  const time = (at: string) => {
    const ms = Date.parse(at)
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
  }
  return entries
    .map((entry, index) => ({ entry, index, ms: time(entry.at) }))
    .sort((a, b) => (b.ms === a.ms ? a.index - b.index : b.ms - a.ms))
    .map(({ entry }) => entry)
}
