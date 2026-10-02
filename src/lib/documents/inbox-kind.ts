/**
 * Which kind of document an inbox item is, for the list-row badge and the
 * type filter (issue #2129: "one Inkorg view that shows whether each row is
 * a leverantörsfaktura or bokföringsunderlag").
 *
 * Two sources, in priority order:
 *   1. kind_hint: what the sender declared through the +lev / +ver
 *      plus-address tag. A column, so it survives re-extraction.
 *   2. extracted_data.documentKind: the AI classification.
 *
 * A supplier document can be a credit note (issue #2980): the reading says
 * so ('credit_note'), or its amounts do. A supplier invoice whose read net
 * or VAT is below zero credits an earlier invoice, whatever the label: a
 * payable below zero does not exist. The +lev hint says "from a supplier",
 * which a credit note is, so the reading refines it; a +ver receipt stays a
 * receipt (a card refund is booked against the bank row, not credited).
 *
 * Anything outside the known vocabulary resolves to null and shows nothing,
 * rather than guessing.
 *
 * React-free on purpose: this repo has no jsdom or testing-library, so the
 * predicate is tested here rather than through the component.
 */

export const INBOX_DOCUMENT_KINDS = [
  'receipt',
  'supplier_invoice',
  'credit_note',
  'government_letter',
  'other',
] as const

export type InboxDocumentKind = (typeof INBOX_DOCUMENT_KINDS)[number]

/**
 * 'underlag' is everything booked as a verifikat of its own: receipts,
 * government letters and other documents. A credit note belongs with the
 * supplier invoices: it is handled on the invoice it credits.
 */
export type InboxKindFilter = 'all' | 'supplier_invoice' | 'underlag'

export const INBOX_KIND_FILTERS: readonly InboxKindFilter[] = ['all', 'supplier_invoice', 'underlag']

export interface InboxKindSource {
  kind_hint?: string | null
  extracted_data?: {
    documentKind?: string | null
    totals?: { subtotal?: unknown; vatAmount?: unknown; total?: unknown } | null
  } | null
}

export function isInboxDocumentKind(value: unknown): value is InboxDocumentKind {
  return typeof value === 'string' && (INBOX_DOCUMENT_KINDS as readonly string[]).includes(value)
}

const isNegative = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value < 0

/**
 * Whether the read totals are a credit's. A labelled supplier invoice counts
 * with any of total, net or VAT below zero (the reported case read a
 * positive total over a negative net and VAT). An unlabelled reading, from
 * before the classification fields existed, needs the net or the VAT: a lone
 * negative total is as often a bank statement's balance as a credit.
 */
export function readsAsCredit(
  extracted: InboxKindSource['extracted_data'],
  options: { labelled: boolean },
): boolean {
  const totals = extracted?.totals
  if (!totals) return false
  if (isNegative(totals.subtotal) || isNegative(totals.vatAmount)) return true
  return options.labelled && isNegative(totals.total)
}

/** The kind to show for an item: the sender's hint first, then the AI's. */
export function resolveInboxKind(item: InboxKindSource): InboxDocumentKind | null {
  const hint = isInboxDocumentKind(item.kind_hint) ? item.kind_hint : null
  if (hint === 'receipt') return hint
  const aiKind = item.extracted_data?.documentKind
  const read = isInboxDocumentKind(aiKind) ? aiKind : null
  if (read === 'credit_note' && (hint === null || hint === 'supplier_invoice')) return 'credit_note'
  const kind = hint ?? read
  if (kind === 'supplier_invoice' && readsAsCredit(item.extracted_data, { labelled: true })) return 'credit_note'
  if (kind === null && readsAsCredit(item.extracted_data, { labelled: false })) return 'credit_note'
  return kind
}

/**
 * Whether a resolved kind passes the type filter. An unclassified item
 * (null) only passes 'all': the narrow filters promise a known kind.
 */
export function matchesInboxKindFilter(
  kind: InboxDocumentKind | null,
  filter: InboxKindFilter,
): boolean {
  if (filter === 'all') return true
  if (kind === null) return false
  const supplierSide = kind === 'supplier_invoice' || kind === 'credit_note'
  if (filter === 'supplier_invoice') return supplierSide
  return !supplierSide
}
