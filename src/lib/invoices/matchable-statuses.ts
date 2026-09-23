/**
 * Invoice statuses a bank transaction can still be matched against.
 *
 * These mirror the CAS guards the match routes actually enforce:
 *   app/api/transactions/[id]/match-invoice/route.ts          (.in('status', ...))
 *   app/api/transactions/[id]/match-supplier-invoice/route.ts (.in('status', ...))
 *
 * Every surface that offers a match (suggestion lists, the match dialog, the
 * batch-allocation picker) must filter on the same lists. Offering a target
 * outside them produces a confirm button that can only ever fail with
 * MATCH_INVOICE_ALREADY_PAID / MATCH_SI_ALREADY_PAID.
 *
 * Dependency-free on purpose: client components import this too.
 */
export const MATCHABLE_INVOICE_STATUSES = ['sent', 'overdue', 'partially_paid'] as const

export const MATCHABLE_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'overdue',
  'partially_paid',
] as const

export type InvoiceMatchTargetState = 'matchable' | 'settled' | 'not_open'

type MatchCandidate = {
  status?: string | null
  remaining_amount?: number | null
}

function getMatchTargetState(
  candidate: MatchCandidate | null | undefined,
  matchableStatuses: readonly string[],
): InvoiceMatchTargetState {
  if (!candidate?.status) return 'not_open'

  const hasMatchableStatus = matchableStatuses.includes(candidate.status)
  if (!hasMatchableStatus) {
    return candidate.status === 'paid' ? 'settled' : 'not_open'
  }

  return (candidate.remaining_amount ?? 0) > 0 ? 'matchable' : 'settled'
}

export function getInvoiceMatchTargetState(
  candidate: MatchCandidate | null | undefined,
): InvoiceMatchTargetState {
  return getMatchTargetState(candidate, MATCHABLE_INVOICE_STATUSES)
}

export function getSupplierInvoiceMatchTargetState(
  candidate: MatchCandidate | null | undefined,
): InvoiceMatchTargetState {
  return getMatchTargetState(candidate, MATCHABLE_SUPPLIER_INVOICE_STATUSES)
}

/**
 * A candidate is matchable when its status is still open AND it has an
 * outstanding balance. Both columns are NOT NULL in the schema (migrations
 * 20240101000025 / 20260323120001), so a missing value cannot silently hide a
 * legitimate suggestion here.
 */
export function isMatchableInvoice(
  candidate: MatchCandidate | null | undefined,
): boolean {
  return getInvoiceMatchTargetState(candidate) === 'matchable'
}

export function isMatchableSupplierInvoice(
  candidate: MatchCandidate | null | undefined,
): boolean {
  return getSupplierInvoiceMatchTargetState(candidate) === 'matchable'
}

/**
 * Statuses under which an invoice has NOT been issued: no document exists that
 * could serve as underlag for a verifikat. The schema says the same thing from
 * the other side (migration 20260427150000: an invoice outside these statuses
 * must carry an invoice_number). Every reader that treats a customer invoice
 * pointing at a verifikat as its underlag (BFL 5 kap 7 § hänvisning) must
 * exclude these, in step with the SQL arm in verifikat_without_documents /
 * transactions_without_documents (migration 20260906135702, #2298).
 */
export const NON_ISSUED_INVOICE_STATUSES = ['draft', 'cancelled'] as const

/** PostgREST `not.in` literal for {@link NON_ISSUED_INVOICE_STATUSES}. */
export const NON_ISSUED_INVOICE_STATUSES_FILTER =
  '(' + NON_ISSUED_INVOICE_STATUSES.map((s) => `"${s}"`).join(',') + ')'
