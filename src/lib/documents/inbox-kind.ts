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
 * Anything outside the known vocabulary resolves to null and shows nothing,
 * rather than guessing.
 *
 * React-free on purpose: this repo has no jsdom or testing-library, so the
 * predicate is tested here rather than through the component.
 */

export const INBOX_DOCUMENT_KINDS = [
  'receipt',
  'supplier_invoice',
  'government_letter',
  'other',
] as const

export type InboxDocumentKind = (typeof INBOX_DOCUMENT_KINDS)[number]

/**
 * 'underlag' is everything that is not a supplier invoice: receipts,
 * government letters and other documents all book as bokföringsunderlag.
 */
export type InboxKindFilter = 'all' | 'supplier_invoice' | 'underlag'

export const INBOX_KIND_FILTERS: readonly InboxKindFilter[] = ['all', 'supplier_invoice', 'underlag']

export interface InboxKindSource {
  kind_hint?: string | null
  extracted_data?: { documentKind?: string | null } | null
}

function isInboxDocumentKind(value: unknown): value is InboxDocumentKind {
  return typeof value === 'string' && (INBOX_DOCUMENT_KINDS as readonly string[]).includes(value)
}

/** The kind to show for an item: the sender's hint first, then the AI's. */
export function resolveInboxKind(item: InboxKindSource): InboxDocumentKind | null {
  if (isInboxDocumentKind(item.kind_hint)) return item.kind_hint
  const aiKind = item.extracted_data?.documentKind
  return isInboxDocumentKind(aiKind) ? aiKind : null
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
  if (filter === 'supplier_invoice') return kind === 'supplier_invoice'
  return kind !== 'supplier_invoice'
}
