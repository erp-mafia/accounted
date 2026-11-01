/**
 * Statuses of an invoice the customer still owes, the one list for every
 * reader: reminders, collections, the reskontra, the year-end reads. In a
 * query, filterOwedInvoices (lib/invoices/overdue.ts) adds what else makes an
 * invoice owed: a real faktura with something remaining. SQL spells the same
 * list out (match_batch_allocate, the link RPCs, book_counterparty_setoff).
 *
 * Dependency-free on purpose: client components import this too.
 */
export const OWED_INVOICE_STATUSES = ['sent', 'overdue', 'partially_paid'] as const

/**
 * Invoice statuses a bank transaction can still be matched against: what is
 * owed takes a payment.
 *
 * The match routes' CAS guards (dashboard and v1 match-invoice and
 * match-supplier-invoice), the link to an existing verifikat, the agent's
 * match tools, the suggestion passes and the pickers all read these lists, so
 * a surface cannot offer a target the confirm refuses with
 * MATCH_INVOICE_ALREADY_PAID / MATCH_SI_ALREADY_PAID, nor hide one it takes.
 */
export const MATCHABLE_INVOICE_STATUSES = OWED_INVOICE_STATUSES

export const MATCHABLE_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'overdue',
  'partially_paid',
] as const

/** Whether the customer still owes on an invoice in this status. */
export function isOwedInvoiceStatus(status: string | null | undefined): boolean {
  return (OWED_INVOICE_STATUSES as readonly string[]).includes(status ?? '')
}

/** Whether a customer invoice in this status can still take a matched payment. */
export const isMatchableInvoiceStatus = isOwedInvoiceStatus

/** Whether a supplier invoice in this status can still take a matched payment. */
export function isMatchableSupplierInvoiceStatus(status: string | null | undefined): boolean {
  return (MATCHABLE_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(status ?? '')
}

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
